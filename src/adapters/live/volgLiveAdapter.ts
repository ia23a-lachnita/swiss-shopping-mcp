import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { VolgParsedProduct, parseVolgWooCommerceResponse } from '../../parsers/volg.js';
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

const VOLG_PROVIDER = 'Volg';
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SEARCH_LIMIT = 20;
const BASE_URL = 'https://www.volgshop.ch';

export interface VolgLiveAdapterOptions {
  cache: FileTtlCache;
  cacheTtlMs?: number;
}

function toNormalizedProduct(product: VolgParsedProduct, provenance: import('../types.js').SourceProvenance): NormalizedProduct {
  return {
    id: product.id,
    chain: 'volg',
    name: product.name,
    brand: product.brand,
    price: { current: product.price.current },
    category: product.category,
    image: product.image,
    productUrl: product.productUrl,
    tags: product.tags,
    provenance: { ...provenance, sourceUrl: product.sourceUrl },
  };
}

export class VolgLiveAdapter implements ChainAdapter {
  public readonly chain = 'volg' as const;
  private readonly cache: FileTtlCache;
  private readonly sourceClient: SourceHttpClient;
  private readonly cacheTtlMs: number;

  public constructor(options: VolgLiveAdapterOptions) {
    this.cache = options.cache;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.sourceClient = new SourceHttpClient({ rateLimitPerHostMs: 1_000 });
  }

  public async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
    const query = filters.query.trim();
    if (!query) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' } };
    }

    const limit = typeof filters.limit === 'number' ? filters.limit : DEFAULT_SEARCH_LIMIT;
    const searchUrl = `${BASE_URL}/wp-json/wc/store/v1/products?search=${encodeURIComponent(query)}&per_page=${limit}`;
    const loaded = await loadJson(searchUrl, 'volg:search', this.cache, this.sourceClient, this.cacheTtlMs, 'volg', VOLG_PROVIDER);
    if (!loaded.ok) {
      return { ok: false, error: loaded.error };
    }

    const parsed = parseVolgWooCommerceResponse(loaded.data, searchUrl);
    const matchMode = filters.matchMode ?? 'balanced';
    const products = parsed
      .map((p) => toNormalizedProduct(p, loaded.provenance))
      .filter((product) => productMatches(product, query, filters))
      .sort((a, b) => sortProducts(a, b, query, matchMode));

    const limitedProducts = products.slice(0, limit);

    return { ok: true, data: limitedProducts, metadata: metadataFrom([loaded.provenance], loaded.warnings, 'volg', VOLG_PROVIDER, 'Volg data is sourced from live retailer API endpoints.', 'Volg data is sourced from cached retailer observations.') };
  }

  public async searchPromotions(_filters: PromotionSearchFilters): Promise<Result<NormalizedPromotion[]>> {
    return { ok: false, error: { code: SourceWarningCode.RealSourceNotImplemented, message: 'Volg promotions search is not yet implemented.' } };
  }

  public async findStores(_filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
    // Volgshop is delivery-only — no physical store search available
    return {
      ok: true,
      data: [],
      metadata: {
        sources: [{
          chain: 'volg',
          status: 'live-beta',
          provider: VOLG_PROVIDER,
          sourceType: 'retailer-web',
          lastObservedAt: new Date().toISOString(),
        }],
        summary: 'Volgshop is a delivery-only service — no physical store search available.',
      },
    };
  }

  public getStoreAvailabilitySupport(): StoreAvailabilitySupport {
    return { chain: this.chain, supported: false, reason: 'Volgshop is a delivery-only service.' };
  }

  public async lookupStoreProductAvailability(
    filters: StoreProductAvailabilityFilters
  ): Promise<Result<StoreProductAvailabilityResult>> {
    return {
      ok: true,
      data: { chain: this.chain, storeId: filters.storeId, query: filters.query, supported: false, reason: 'Volgshop is a delivery-only service.', matches: [], isAvailable: false },
    };
  }
}
