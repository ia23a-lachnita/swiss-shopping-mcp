import {
  Chain,
  ChainAdapter,
  NormalizedProduct,
  NormalizedStore,
  ProductSearchFilters,
  Result,
  ResultMetadata,
  StoreAvailabilitySupport,
  StoreProductAvailabilityFilters,
  StoreProductAvailabilityResult,
  StoreSearchFilters,
} from '../adapters/types.js';
import { sourceWarningFromError } from '../sources/warnings.js';
import { sortProducts } from '../util/matcher.js';

function sortStores(a: NormalizedStore, b: NormalizedStore): number {
  return a.name.localeCompare(b.name);
}

function mergeMetadata(metadataEntries: ResultMetadata[], sourceWarnings: ResultMetadata['sourceWarnings']): ResultMetadata | undefined {
  const warnings = [
    ...metadataEntries.flatMap((metadata) => metadata.sourceWarnings ?? []),
    ...(sourceWarnings ?? []),
  ];
  const sources = metadataEntries.flatMap((metadata) => metadata.sources ?? []);
  const summary = metadataEntries
    .map((metadata) => metadata.summary)
    .filter((entry): entry is string => entry !== undefined)
    .join(' ');

  if (warnings.length === 0 && sources.length === 0 && !summary) {
    return undefined;
  }

  return {
    ...(warnings.length > 0 ? { sourceWarnings: warnings } : {}),
    ...(sources.length > 0 ? { sources } : {}),
    ...(summary ? { summary } : {}),
  };
}

export class SearchService {
  private readonly adapters: ChainAdapter[];

  public constructor(adapters: ChainAdapter[]) {
    this.adapters = adapters;
  }

  public async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
    const query = filters.query.trim();
    if (!query) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' } };
    }

    const matchMode = filters.matchMode ?? 'balanced';
    const requestedChains = new Set(filters.chains ?? this.adapters.map((adapter) => adapter.chain));
    const relevantAdapters = this.adapters.filter((adapter) => requestedChains.has(adapter.chain));
    if (relevantAdapters.length === 0) {
      return { ok: false, error: { code: 'CHAIN_NOT_SUPPORTED', message: 'No supported chains were requested.' } };
    }

    const adapterResults = await Promise.all(
      relevantAdapters.map(async (adapter) => ({
        chain: adapter.chain,
        result: await adapter.searchProducts({ ...filters, query, matchMode }),
      })),
    );

    const sourceWarnings = adapterResults
      .filter((entry) => !entry.result.ok)
      .map((entry) => sourceWarningFromError(entry.chain, entry.result.ok ? { code: 'UNKNOWN' } : entry.result.error));

    const successfulResults = adapterResults.filter((entry) => entry.result.ok);
    if (successfulResults.length === 0 && sourceWarnings.length > 0) {
      return {
        ok: false,
        error: {
          code: 'ALL_SOURCES_FAILED',
          message: sourceWarnings.map((warning) => `${warning.chain}: ${warning.message}`).join('; '),
        },
      };
    }

    const products = successfulResults.flatMap((entry) => (entry.result.ok ? entry.result.data : []));
    products.sort((a, b) => sortProducts(a, b, query, matchMode));
    const metadata = mergeMetadata(
      successfulResults.flatMap((entry) => (entry.result.ok && entry.result.metadata ? [entry.result.metadata] : [])),
      sourceWarnings,
    );

    if (typeof filters.limit === 'number') {
      return { ok: true, data: products.slice(0, filters.limit), metadata };
    }

    return { ok: true, data: products, metadata };
  }

  public async findStores(filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
    const location = filters.location.trim();
    if (!location) {
      return {
        ok: false,
        error: { code: 'INVALID_LOCATION', message: 'Location must be a non-empty string.' },
      };
    }

    const requestedChains = new Set(filters.chains ?? this.adapters.map((adapter) => adapter.chain));
    const relevantAdapters = this.adapters.filter((adapter) => requestedChains.has(adapter.chain));
    if (relevantAdapters.length === 0) {
      return { ok: false, error: { code: 'CHAIN_NOT_SUPPORTED', message: 'No supported chains were requested.' } };
    }

    const adapterResults = await Promise.all(
      relevantAdapters.map(async (adapter) => ({
        chain: adapter.chain,
        result: await adapter.findStores({ ...filters, location }),
      })),
    );

    const sourceWarnings = adapterResults
      .filter((entry) => !entry.result.ok)
      .map((entry) => sourceWarningFromError(entry.chain, entry.result.ok ? { code: 'UNKNOWN' } : entry.result.error));

    const successfulResults = adapterResults.filter((entry) => entry.result.ok);
    if (successfulResults.length === 0 && sourceWarnings.length > 0) {
      return {
        ok: false,
        error: {
          code: 'ALL_SOURCES_FAILED',
          message: sourceWarnings.map((warning) => `${warning.chain}: ${warning.message}`).join('; '),
        },
      };
    }

    const stores = successfulResults.flatMap((entry) => (entry.result.ok ? entry.result.data : []));
    stores.sort(sortStores);
    const metadata = mergeMetadata(
      successfulResults.flatMap((entry) => (entry.result.ok && entry.result.metadata ? [entry.result.metadata] : [])),
      sourceWarnings,
    );

    if (typeof filters.limit === 'number') {
      return { ok: true, data: stores.slice(0, filters.limit), metadata };
    }

    return { ok: true, data: stores, metadata };
  }

  public getStoreAvailabilitySupport(chains?: Chain[]): StoreAvailabilitySupport[] {
    const requestedChains = new Set(chains ?? this.adapters.map((adapter) => adapter.chain));
    return this.adapters
      .filter((adapter) => requestedChains.has(adapter.chain))
      .map((adapter) => adapter.getStoreAvailabilitySupport())
      .sort((a, b) => a.chain.localeCompare(b.chain));
  }

  public async lookupStoreProductAvailability(
    chain: Chain,
    filters: StoreProductAvailabilityFilters,
  ): Promise<Result<StoreProductAvailabilityResult>> {
    const adapter = this.adapters.find((candidate) => candidate.chain === chain);
    if (!adapter) {
      return { ok: false, error: { code: 'CHAIN_NOT_SUPPORTED', message: `Unsupported chain: ${chain}` } };
    }

    return adapter.lookupStoreProductAvailability(filters);
  }
}
