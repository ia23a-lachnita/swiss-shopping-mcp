import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { VolgParsedProduct, VolgParsedStore, VolgProduct, VolgStore, parseVolgSearchResponse, parseVolgStoresResponse } from '../../parsers/volg.js';
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

const VOLG_PROVIDER = 'Volg';
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SEARCH_LIMIT = 20;

export interface VolgLiveAdapterOptions {
  cache: FileTtlCache;
  sourceClient?: SourceHttpClient;
  searchApiUrl?: string;
  storesApiUrl?: string;
  cacheTtlMs?: number;
}

function toNormalizedProduct(product: VolgParsedProduct, provenance: SourceProvenance): NormalizedProduct {
  return {
    id: product.id,
    chain: 'volg',
    name: product.name,
    brand: product.brand,
    price: { current: product.price.current },
    category: product.category,
    image: product.image,
    tags: product.tags,
    provenance: { ...provenance, sourceUrl: product.sourceUrl },
  };
}

function toNormalizedStore(store: VolgParsedStore, provenance: SourceProvenance): NormalizedStore {
  return {
    id: store.id,
    chain: 'volg',
    name: store.name,
    address: store.address,
    location: { latitude: store.latitude, longitude: store.longitude },
    openingHours: store.openingHours,
    provenance,
  };
}

export class VolgLiveAdapter implements ChainAdapter {
  public readonly chain = 'volg' as const;
  private readonly cache: FileTtlCache;
  private readonly sourceClient: SourceHttpClient;
  private readonly searchApiUrl: string;
  private readonly storesApiUrl: string;
  private readonly cacheTtlMs: number;

  public constructor(options: VolgLiveAdapterOptions) {
    this.cache = options.cache;
    this.sourceClient = options.sourceClient ?? new SourceHttpClient({ rateLimitPerHostMs: 1_000 });
    this.searchApiUrl = options.searchApiUrl ?? 'https://www.volgshop.ch/de/search';
    this.storesApiUrl = options.storesApiUrl ?? 'https://www.volg.ch/de/filialfinder';
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  public async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
    const query = filters.query.trim();
    if (!query) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' } };
    }

    const searchUrl = `${this.searchApiUrl}?q=${encodeURIComponent(query)}`;
    const loaded = await loadJson(searchUrl, 'volg:search', this.cache, this.sourceClient, this.cacheTtlMs, 'volg', VOLG_PROVIDER);
    if (!loaded.ok) {
      return { ok: false, error: loaded.error };
    }

    const parsed = parseVolgSearchResponse(loaded.data as VolgProduct[], searchUrl);
    const matchMode = filters.matchMode ?? 'balanced';
    const products = parsed
      .map((p) => toNormalizedProduct(p, loaded.provenance))
      .filter((product) => productMatches(product, query, filters))
      .sort((a, b) => sortProducts(a, b, query, matchMode));

    const limitedProducts = typeof filters.limit === 'number' ? products.slice(0, filters.limit) : products.slice(0, DEFAULT_SEARCH_LIMIT);

    return { ok: true, data: limitedProducts, metadata: metadataFrom([loaded.provenance], loaded.warnings, 'volg', VOLG_PROVIDER, 'Volg data is sourced from live retailer web pages.', 'Volg data is sourced from cached retailer observations.') };
  }

  public async searchPromotions(_filters: PromotionSearchFilters): Promise<Result<NormalizedPromotion[]>> {
    return { ok: false, error: { code: SourceWarningCode.RealSourceNotImplemented, message: 'Volg promotions search is not yet implemented.' } };
  }

  public async findStores(filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
    const location = filters.location.trim();
    if (!location) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Location must be a non-empty string.' } };
    }

    const storesUrl = `${this.storesApiUrl}?q=${encodeURIComponent(location)}`;
    const loaded = await loadJson(storesUrl, 'volg:stores', this.cache, this.sourceClient, this.cacheTtlMs, 'volg', VOLG_PROVIDER);
    if (!loaded.ok) {
      return { ok: false, error: loaded.error };
    }

    const parsed = parseVolgStoresResponse(loaded.data as VolgStore[], storesUrl);
    const stores = parsed.map((s) => toNormalizedStore(s, loaded.provenance));
    const limitedStores = typeof filters.limit === 'number' ? stores.slice(0, filters.limit) : stores;

    return { ok: true, data: limitedStores, metadata: metadataFrom([loaded.provenance], loaded.warnings, 'volg', VOLG_PROVIDER, 'Volg data is sourced from live retailer web pages.', 'Volg data is sourced from cached retailer observations.') };
  }

  public getStoreAvailabilitySupport(): StoreAvailabilitySupport {
    return { chain: this.chain, supported: false, reason: 'Volg does not expose store-level product availability.' };
  }

  public async lookupStoreProductAvailability(
    filters: StoreProductAvailabilityFilters
  ): Promise<Result<StoreProductAvailabilityResult>> {
    return {
      ok: true,
      data: { chain: this.chain, storeId: filters.storeId, query: filters.query, supported: false, reason: 'Volg does not expose store-level product availability.', matches: [], isAvailable: false },
    };
  }

}
