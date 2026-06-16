import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { OttosParsedProduct, OttosParsedStore, OttosProduct, OttosStore, parseOttosSearchResponse, parseOttosStoresResponse } from '../../parsers/ottos.js';
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

const OTTOS_PROVIDER = "Otto's";
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SEARCH_LIMIT = 20;

export interface OttosLiveAdapterOptions {
  cache: FileTtlCache;
  sourceClient?: SourceHttpClient;
  searchApiUrl?: string;
  storesApiUrl?: string;
  cacheTtlMs?: number;
}

function toNormalizedProduct(product: OttosParsedProduct, provenance: SourceProvenance): NormalizedProduct {
  return {
    id: product.id,
    chain: 'ottos',
    name: product.name,
    brand: product.brand,
    price: { current: product.price.current },
    category: product.category,
    image: product.image,
    provenance: { ...provenance, sourceUrl: product.sourceUrl },
  };
}

function toNormalizedStore(store: OttosParsedStore, provenance: SourceProvenance): NormalizedStore {
  return {
    id: store.id,
    chain: 'ottos',
    name: store.name,
    address: store.address,
    location: { latitude: store.latitude, longitude: store.longitude },
    openingHours: store.openingHours,
    provenance,
  };
}

export class OttosLiveAdapter implements ChainAdapter {
  public readonly chain = 'ottos' as const;
  private readonly cache: FileTtlCache;
  private readonly sourceClient: SourceHttpClient;
  private readonly searchApiUrl: string;
  private readonly storesApiUrl: string;
  private readonly cacheTtlMs: number;

  public constructor(options: OttosLiveAdapterOptions) {
    this.cache = options.cache;
    this.sourceClient = options.sourceClient ?? new SourceHttpClient({ rateLimitPerHostMs: 1_000 });
    this.searchApiUrl = options.searchApiUrl ?? 'https://www.ottos.ch/de/search';
    this.storesApiUrl = options.storesApiUrl ?? 'https://www.ottos.ch/de/store-finder';
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  public async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
    const query = filters.query.trim();
    if (!query) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' } };
    }

    const searchUrl = `${this.searchApiUrl}?q=${encodeURIComponent(query)}`;
    const loaded = await loadJson(searchUrl, 'ottos:search', this.cache, this.sourceClient, this.cacheTtlMs, 'ottos', OTTOS_PROVIDER);
    if (!loaded.ok) {
      return { ok: false, error: loaded.error };
    }

    const parsed = parseOttosSearchResponse(loaded.data as OttosProduct[], searchUrl);
    const matchMode = filters.matchMode ?? 'balanced';
    const products = parsed
      .map((p) => toNormalizedProduct(p, loaded.provenance))
      .filter((product) => productMatches(product, query, filters))
      .sort((a, b) => sortProducts(a, b, query, matchMode));

    const limitedProducts = typeof filters.limit === 'number' ? products.slice(0, filters.limit) : products.slice(0, DEFAULT_SEARCH_LIMIT);

    return { ok: true, data: limitedProducts, metadata: metadataFrom([loaded.provenance], loaded.warnings, 'ottos', OTTOS_PROVIDER, "Otto's data is sourced from live retailer web pages.", "Otto's data is sourced from cached retailer observations.") };
  }

  public async searchPromotions(_filters: PromotionSearchFilters): Promise<Result<NormalizedPromotion[]>> {
    return { ok: false, error: { code: SourceWarningCode.RealSourceNotImplemented, message: "Otto's promotions search is not yet implemented." } };
  }

  public async findStores(filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
    const location = filters.location.trim();
    if (!location) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Location must be a non-empty string.' } };
    }

    const storesUrl = `${this.storesApiUrl}?q=${encodeURIComponent(location)}`;
    const loaded = await loadJson(storesUrl, 'ottos:stores', this.cache, this.sourceClient, this.cacheTtlMs, 'ottos', OTTOS_PROVIDER);
    if (!loaded.ok) {
      return { ok: false, error: loaded.error };
    }

    const parsed = parseOttosStoresResponse(loaded.data as OttosStore[], storesUrl);
    const stores = parsed.map((s) => toNormalizedStore(s, loaded.provenance));
    const limitedStores = typeof filters.limit === 'number' ? stores.slice(0, filters.limit) : stores;

    return { ok: true, data: limitedStores, metadata: metadataFrom([loaded.provenance], loaded.warnings, 'ottos', OTTOS_PROVIDER, "Otto's data is sourced from live retailer web pages.", "Otto's data is sourced from cached retailer observations.") };
  }

  public getStoreAvailabilitySupport(): StoreAvailabilitySupport {
    return { chain: this.chain, supported: false, reason: "Otto's store-level product availability is not yet implemented." };
  }

  public async lookupStoreProductAvailability(
    filters: StoreProductAvailabilityFilters
  ): Promise<Result<StoreProductAvailabilityResult>> {
    return {
      ok: true,
      data: { chain: this.chain, storeId: filters.storeId, query: filters.query, supported: false, reason: "Otto's store-level product availability is not yet implemented.", matches: [], isAvailable: false },
    };
  }

}
