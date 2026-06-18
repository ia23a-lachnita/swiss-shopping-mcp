import { FileTtlCache } from '../../cache/fileTtlCache.js';
import {
  OttosOccProduct,
  OttosOccStore,
  OttosParsedProduct,
  OttosParsedStore,
  parseOttosOccProduct,
  parseOttosOccStore,
} from '../../parsers/ottos.js';
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
  SourceWarningCode,
  StoreAvailabilitySupport,
  StoreProductAvailabilityFilters,
  StoreProductAvailabilityResult,
  StoreSearchFilters,
} from '../types.js';

const OTTOS_PROVIDER = "Otto's";
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SEARCH_LIMIT = 20;
const BASE_URL = 'https://api.ottos.ch/occ/v2/ottos';
const IOS_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export interface OttosLiveAdapterOptions {
  cache: FileTtlCache;
  cacheTtlMs?: number;
}

function toNormalizedProduct(product: OttosParsedProduct, provenance: import('../types.js').SourceProvenance): NormalizedProduct {
  return {
    id: product.id,
    chain: 'ottos',
    name: product.name,
    brand: product.brand,
    price: { current: product.price.current },
    category: product.category,
    image: product.image,
    productUrl: product.url ? `https://www.ottos.ch${product.url}` : undefined,
    provenance: { ...provenance, sourceUrl: product.sourceUrl },
  };
}

function toNormalizedStore(store: OttosParsedStore, provenance: import('../types.js').SourceProvenance): NormalizedStore {
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
  private readonly cacheTtlMs: number;

  public constructor(options: OttosLiveAdapterOptions) {
    this.cache = options.cache;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.sourceClient = new SourceHttpClient({ rateLimitPerHostMs: 1_000, userAgent: IOS_SAFARI_UA });
  }

  public async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
    const query = filters.query.trim();
    if (!query) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' } };
    }

    const limit = typeof filters.limit === 'number' ? filters.limit : DEFAULT_SEARCH_LIMIT;
    const searchUrl = `${BASE_URL}/products/search?query=${encodeURIComponent(query)}:relevance&pageSize=${limit}&fields=FULL`;
    const loaded = await loadJson(searchUrl, 'ottos:search', this.cache, this.sourceClient, this.cacheTtlMs, 'ottos', OTTOS_PROVIDER);
    if (!loaded.ok) {
      return { ok: false, error: loaded.error };
    }

    const raw = loaded.data as { products?: OttosOccProduct[] };
    const products = (raw.products ?? [])
      .map((p) => parseOttosOccProduct(p, searchUrl))
      .filter((p): p is OttosParsedProduct => p !== undefined);

    const matchMode = filters.matchMode ?? 'balanced';
    const normalized = products
      .map((p) => toNormalizedProduct(p, loaded.provenance))
      .filter((product) => productMatches(product, query, filters))
      .sort((a, b) => sortProducts(a, b, query, matchMode));

    const limitedProducts = normalized.slice(0, limit);

    return { ok: true, data: limitedProducts, metadata: metadataFrom([loaded.provenance], loaded.warnings, 'ottos', OTTOS_PROVIDER, "Otto's data is sourced from live retailer API endpoints.", "Otto's data is sourced from cached retailer observations.") };
  }

  public async searchPromotions(_filters: PromotionSearchFilters): Promise<Result<NormalizedPromotion[]>> {
    return { ok: false, error: { code: SourceWarningCode.RealSourceNotImplemented, message: "Otto's promotions search is not yet implemented." } };
  }

  public async findStores(filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
    const location = filters.location.trim();
    if (!location) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Location must be a non-empty string.' } };
    }

    const storesUrl = `${BASE_URL}/stores?query=${encodeURIComponent(location)}&fields=FULL`;
    const loaded = await loadJson(storesUrl, 'ottos:stores', this.cache, this.sourceClient, this.cacheTtlMs, 'ottos', OTTOS_PROVIDER);
    if (!loaded.ok) {
      return { ok: false, error: loaded.error };
    }

    const raw = loaded.data as { stores?: OttosOccStore[] };
    const stores = (raw.stores ?? [])
      .map((s, i) => parseOttosOccStore(s, i, storesUrl))
      .filter((s): s is OttosParsedStore => s !== undefined)
      .map((s) => toNormalizedStore(s, loaded.provenance));

    const limitedStores = typeof filters.limit === 'number' ? stores.slice(0, filters.limit) : stores;

    return { ok: true, data: limitedStores, metadata: metadataFrom([loaded.provenance], loaded.warnings, 'ottos', OTTOS_PROVIDER, "Otto's data is sourced from live retailer API endpoints.", "Otto's data is sourced from cached retailer observations.") };
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
