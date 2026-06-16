import { FileTtlCache } from '../../cache/fileTtlCache.js';
import {
  CoopParsedProduct,
  CoopParsedStore,
  CoopProduct,
  CoopSearchResponse,
  CoopStore,
  CoopStoresResponse,
  parseCoopSearchResponse,
  parseCoopStoresResponse,
} from '../../parsers/coop.js';
import { SourceHttpClient } from '../../sources/sourceClient.js';
import { sortProducts } from '../../util/matcher.js';
import {
  metadataFrom,
  loadJson,
  productMatches,
} from './baseLiveAdapter.js';
import {
  ChainAdapter,
  NormalizedProduct,
  NormalizedPromotion,
  NormalizedStore,
  ProductSearchFilters,
  PromotionSearchFilters,
  Result,
  SourceProvenance,
  SourceWarningCode,
  StoreAvailabilitySupport,
  StoreProductAvailabilityFilters,
  StoreProductAvailabilityResult,
  StoreSearchFilters,
} from '../types.js';

const COOP_PROVIDER = 'Coop';
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SEARCH_LIMIT = 20;

export interface CoopLiveAdapterOptions {
  cache: FileTtlCache;
  sourceClient?: SourceHttpClient;
  searchApiUrl?: string;
  storesApiUrl?: string;
  cacheTtlMs?: number;
}

function toNormalizedProduct(
  product: CoopParsedProduct,
  provenance: SourceProvenance
): NormalizedProduct {
  return {
    id: product.id,
    chain: 'coop',
    name: product.name,
    brand: product.brand,
    price: {
      current: product.price.current,
      unit: product.unit,
    },
    category: product.category,
    image: product.image,
    nutrition: product.nutrition,
    allergens: product.allergens,
    provenance: { ...provenance, sourceUrl: product.sourceUrl },
  };
}

function toNormalizedStore(
  store: CoopParsedStore,
  provenance: SourceProvenance
): NormalizedStore {
  return {
    id: store.id,
    chain: 'coop',
    name: store.name,
    address: store.address,
    location: { latitude: store.latitude, longitude: store.longitude },
    openingHours: store.openingHours,
    provenance: { ...provenance, sourceUrl: store.sourceUrl },
  };
}

export class CoopLiveAdapter implements ChainAdapter {
  public readonly chain = 'coop' as const;
  private readonly cache: FileTtlCache;
  private readonly sourceClient: SourceHttpClient;
  private readonly searchApiUrl: string;
  private readonly storesApiUrl: string;
  private readonly cacheTtlMs: number;

  public constructor(options: CoopLiveAdapterOptions) {
    this.cache = options.cache;
    this.sourceClient =
      options.sourceClient ?? new SourceHttpClient({ rateLimitPerHostMs: 500 });
    this.searchApiUrl =
      options.searchApiUrl ?? 'https://www.coop.ch/de/search';
    this.storesApiUrl =
      options.storesApiUrl ?? 'https://www.coop.ch/de/store-finder';
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  public async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
    const query = filters.query.trim();
    if (!query) {
      return {
        ok: false,
        error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' },
      };
    }

    const searchUrl = `${this.searchApiUrl}?q=${encodeURIComponent(query)}`;
    const loaded = await loadJson(searchUrl, 'coop:search', this.cache, this.sourceClient, this.cacheTtlMs, 'coop', COOP_PROVIDER);
    if (!loaded.ok) {
      return { ok: false, error: loaded.error };
    }

    const parsed = parseCoopSearchResponse(loaded.data as CoopSearchResponse | CoopProduct[], searchUrl);
    const matchMode = filters.matchMode ?? 'balanced';
    const products = parsed
      .map((p) => toNormalizedProduct(p, loaded.provenance))
      .filter((product) => productMatches(product, query, filters))
      .sort((a, b) => sortProducts(a, b, query, matchMode));

    const limitedProducts =
      typeof filters.limit === 'number'
        ? products.slice(0, filters.limit)
        : products.slice(0, DEFAULT_SEARCH_LIMIT);

    return {
      ok: true,
      data: limitedProducts,
      metadata: metadataFrom([loaded.provenance], loaded.warnings, 'coop', COOP_PROVIDER, 'Coop data is sourced from live retailer API endpoints.', 'Coop data is sourced from cached retailer observations.'),
    };
  }

  public async searchPromotions(
    _filters: PromotionSearchFilters
  ): Promise<Result<NormalizedPromotion[]>> {
    return {
      ok: false,
      error: {
        code: SourceWarningCode.RealSourceNotImplemented,
        message: 'Coop promotions search is not yet implemented.',
      },
    };
  }

  public async findStores(filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
    const location = filters.location.trim();
    if (!location) {
      return {
        ok: false,
        error: { code: 'INVALID_QUERY', message: 'Location must be a non-empty string.' },
      };
    }

    const storesUrl = `${this.storesApiUrl}?q=${encodeURIComponent(location)}`;
    const loaded = await loadJson(storesUrl, 'coop:stores', this.cache, this.sourceClient, this.cacheTtlMs, 'coop', COOP_PROVIDER);
    if (!loaded.ok) {
      return { ok: false, error: loaded.error };
    }

    const parsed = parseCoopStoresResponse(loaded.data as CoopStoresResponse | CoopStore[], storesUrl);
    const stores = parsed.map((s) => toNormalizedStore(s, loaded.provenance));
    const limitedStores =
      typeof filters.limit === 'number' ? stores.slice(0, filters.limit) : stores;

    return {
      ok: true,
      data: limitedStores,
      metadata: metadataFrom([loaded.provenance], loaded.warnings, 'coop', COOP_PROVIDER, 'Coop data is sourced from live retailer API endpoints.', 'Coop data is sourced from cached retailer observations.'),
    };
  }

  public getStoreAvailabilitySupport(): StoreAvailabilitySupport {
    return {
      chain: this.chain,
      supported: false,
      reason: 'Coop store-level product availability is not yet implemented.',
    };
  }

  public async lookupStoreProductAvailability(
    filters: StoreProductAvailabilityFilters
  ): Promise<Result<StoreProductAvailabilityResult>> {
    return {
      ok: true,
      data: {
        chain: this.chain,
        storeId: filters.storeId,
        query: filters.query,
        supported: false,
        reason: 'Coop store-level product availability is not yet implemented.',
        matches: [],
        isAvailable: false,
      },
    };
  }

}
