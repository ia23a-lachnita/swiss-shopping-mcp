import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { LidlParsedProduct, LidlParsedStore, parseLidlLeafletProducts, parseLidlStoresResponse } from '../../parsers/lidl.js';
import { SourceHttpClient } from '../../sources/sourceClient.js';
import { sortProducts } from '../../util/matcher.js';
import {
  metadataFrom,
  loadText,
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

const LIDL_PROVIDER = 'Lidl Schweiz';
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SEARCH_LIMIT = 20;

export interface LidlLiveAdapterOptions {
  cache: FileTtlCache;
  sourceClient?: SourceHttpClient;
  leafletUrl?: string;
  storesUrl?: string;
  cacheTtlMs?: number;
}

function toNormalizedProduct(product: LidlParsedProduct, provenance: SourceProvenance): NormalizedProduct {
  return {
    id: product.id,
    chain: 'lidl',
    name: product.name,
    brand: product.brand,
    price: { current: product.price.current },
    category: product.category,
    image: product.image,
    provenance: { ...provenance, sourceUrl: product.sourceUrl },
  };
}

function toNormalizedStore(store: LidlParsedStore, provenance: SourceProvenance): NormalizedStore {
  return {
    id: store.id,
    chain: 'lidl',
    name: store.name,
    address: store.address,
    location: { latitude: store.latitude, longitude: store.longitude },
    openingHours: store.openingHours,
    provenance,
  };
}

export class LidlLiveAdapter implements ChainAdapter {
  public readonly chain = 'lidl' as const;
  private readonly cache: FileTtlCache;
  private readonly sourceClient: SourceHttpClient;
  private readonly leafletUrl: string;
  private readonly storesUrl: string;
  private readonly cacheTtlMs: number;

  public constructor(options: LidlLiveAdapterOptions) {
    this.cache = options.cache;
    this.sourceClient = options.sourceClient ?? new SourceHttpClient({ rateLimitPerHostMs: 1_000 });
    this.leafletUrl = options.leafletUrl ?? 'https://www.lidl.ch/de/angebote';
    this.storesUrl = options.storesUrl ?? 'https://www.lidl.ch/de/filialfinder';
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  public async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
    const query = filters.query.trim();
    if (!query) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' } };
    }

    const loaded = await loadText(this.leafletUrl, 'lidl:leaflet', this.cache, this.sourceClient, this.cacheTtlMs, 'lidl', LIDL_PROVIDER);
    if (!loaded.ok) {
      return { ok: false, error: loaded.error };
    }

    const parsed = parseLidlLeafletProducts(loaded.data, this.leafletUrl);
    const matchMode = filters.matchMode ?? 'balanced';
    const products = parsed
      .map((p) => toNormalizedProduct(p, loaded.provenance))
      .filter((product) => productMatches(product, query, filters))
      .sort((a, b) => sortProducts(a, b, query, matchMode));

    const limitedProducts =
      typeof filters.limit === 'number' ? products.slice(0, filters.limit) : products.slice(0, DEFAULT_SEARCH_LIMIT);

    return {
      ok: true,
      data: limitedProducts,
      metadata: metadataFrom([loaded.provenance], loaded.warnings, 'lidl', LIDL_PROVIDER, 'Lidl data is sourced from live retailer web pages.', 'Lidl data is sourced from cached retailer observations.'),
    };
  }

  public async searchPromotions(_filters: PromotionSearchFilters): Promise<Result<NormalizedPromotion[]>> {
    return {
      ok: false,
      error: {
        code: SourceWarningCode.RealSourceNotImplemented,
        message: 'Lidl promotions search is not yet implemented.',
      },
    };
  }

  public async findStores(filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
    const location = filters.location.trim();
    if (!location) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Location must be a non-empty string.' } };
    }

    const loaded = await loadText(this.storesUrl, 'lidl:stores', this.cache, this.sourceClient, this.cacheTtlMs, 'lidl', LIDL_PROVIDER);
    if (!loaded.ok) {
      return { ok: false, error: loaded.error };
    }

    const parsed = parseLidlStoresResponse(loaded.data, this.storesUrl);
    const stores = parsed.map((s) => toNormalizedStore(s, loaded.provenance));
    const limitedStores = typeof filters.limit === 'number' ? stores.slice(0, filters.limit) : stores;

    return {
      ok: true,
      data: limitedStores,
      metadata: metadataFrom([loaded.provenance], loaded.warnings, 'lidl', LIDL_PROVIDER, 'Lidl data is sourced from live retailer web pages.', 'Lidl data is sourced from cached retailer observations.'),
    };
  }

  public getStoreAvailabilitySupport(): StoreAvailabilitySupport {
    return {
      chain: this.chain,
      supported: false,
      reason: 'Lidl does not expose store-level product availability.',
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
        reason: 'Lidl does not expose store-level product availability.',
        matches: [],
        isAvailable: false,
      },
    };
  }

}
