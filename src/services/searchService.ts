import {
  Chain,
  ChainAdapter,
  NormalizedProduct,
  NormalizedStore,
  ProductSearchFilters,
  Result,
  StoreAvailabilitySupport,
  StoreProductAvailabilityFilters,
  StoreProductAvailabilityResult,
  StoreSearchFilters,
} from '../adapters/types.js';
import { sortProducts } from '../util/matcher.js';

function sortStores(a: NormalizedStore, b: NormalizedStore): number {
  return a.name.localeCompare(b.name);
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

    const adapterResults = await Promise.all(
      relevantAdapters.map((adapter) => adapter.searchProducts({ ...filters, query, matchMode })),
    );

    for (const result of adapterResults) {
      if (!result.ok) {
        return result;
      }
    }

    const products = adapterResults.flatMap((result) => (result.ok ? result.data : []));
    products.sort((a, b) => sortProducts(a, b, query, matchMode));

    if (typeof filters.limit === 'number') {
      return { ok: true, data: products.slice(0, filters.limit) };
    }

    return { ok: true, data: products };
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

    const adapterResults = await Promise.all(
      relevantAdapters.map((adapter) => adapter.findStores({ ...filters, location })),
    );

    for (const result of adapterResults) {
      if (!result.ok) {
        return result;
      }
    }

    const stores = adapterResults.flatMap((result) => (result.ok ? result.data : []));
    stores.sort(sortStores);

    if (typeof filters.limit === 'number') {
      return { ok: true, data: stores.slice(0, filters.limit) };
    }

    return { ok: true, data: stores };
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
