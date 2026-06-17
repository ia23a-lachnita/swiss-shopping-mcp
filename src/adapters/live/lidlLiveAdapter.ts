import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { LidlParsedProduct, LidlParsedStore, parseLidlCampaignProducts, parseLidlStoresResponse } from '../../parsers/lidl.js';
import { SourceHttpClient } from '../../sources/sourceClient.js';
import { sortProducts } from '../../util/matcher.js';
import {
  cacheableProvenance,
  liveProvenanceWithCacheExpiry,
  metadataFrom,
  productMatches,
  staleCacheWarning,
  warningFromError,
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
  SourceWarning,
  SourceWarningCode,
  StoreAvailabilitySupport,
  StoreProductAvailabilityFilters,
  StoreProductAvailabilityResult,
  StoreSearchFilters,
} from '../types.js';

const LIDL_PROVIDER = 'Lidl Schweiz';
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SEARCH_LIMIT = 20;
const CAMPAIGNS_URL = 'https://digital-leaflet.lidlplus.com/api/v1/CH/campaignGroups';
const STORES_URL = 'https://stores.lidlplus.com/api/v2/CH';
const LIDL_PLUS_UA = 'Lidl Plus/5.0.0 (Android; 14; SM-S928B)';

export interface LidlLiveAdapterOptions {
  cache: FileTtlCache;
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
  private readonly cacheTtlMs: number;

  public constructor(options: LidlLiveAdapterOptions) {
    this.cache = options.cache;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.sourceClient = new SourceHttpClient({ rateLimitPerHostMs: 1_000, userAgent: LIDL_PLUS_UA });
  }

  private buildProvenance(sourceUrl: string): SourceProvenance {
    return {
      provider: LIDL_PROVIDER,
      chain: 'lidl',
      sourceType: 'retailer-web',
      sourceUrl,
      observedAt: new Date().toISOString(),
      freshness: 'live',
      confidence: 'medium',
    };
  }

  public async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
    const query = filters.query.trim();
    if (!query) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' } };
    }

    const limit = typeof filters.limit === 'number' ? filters.limit : DEFAULT_SEARCH_LIMIT;
    const cacheKey = `lidl:campaigns:${limit}`;

    const cached = await this.cache.get<unknown>(cacheKey, { allowStale: true });
    if (cached && !cached.isStale) {
      return this.parseProductResult(cached.data, cached.provenance, [], filters, query);
    }

    try {
      const result = await this.sourceClient.fetchJson<unknown>(CAMPAIGNS_URL, {
        provider: LIDL_PROVIDER,
        chain: 'lidl',
        sourceType: 'retailer-web',
        confidence: 'medium',
      });

      const provenance = this.buildProvenance(CAMPAIGNS_URL);
      const record = await this.cache.set(
        cacheKey,
        result.data,
        cacheableProvenance(provenance),
        this.cacheTtlMs
      );

      return this.parseProductResult(
        result.data,
        liveProvenanceWithCacheExpiry(provenance, record.expiresAt),
        [],
        filters,
        query
      );
    } catch (error) {
      const warning = warningFromError(error, CAMPAIGNS_URL, `${LIDL_PROVIDER} API fetch failed`, 'lidl', LIDL_PROVIDER);

      if (cached) {
        return this.parseProductResult(
          cached.data,
          cached.provenance,
          [warning, staleCacheWarning(cached.provenance, 'lidl', LIDL_PROVIDER)],
          filters,
          query
        );
      }

      return {
        ok: false,
        error: { code: warning.code, message: warning.message },
      };
    }
  }

  private parseProductResult(
    data: unknown,
    provenance: SourceProvenance,
    warnings: SourceWarning[],
    filters: ProductSearchFilters,
    query: string
  ): Result<NormalizedProduct[]> {
    const matchMode = filters.matchMode ?? 'balanced';
    const parsed = parseLidlCampaignProducts(data, provenance.sourceUrl ?? CAMPAIGNS_URL);
    const products = parsed
      .map((p) => toNormalizedProduct(p, provenance))
      .filter((product) => productMatches(product, query, filters))
      .sort((a, b) => sortProducts(a, b, query, matchMode));

    const limit = typeof filters.limit === 'number' ? filters.limit : DEFAULT_SEARCH_LIMIT;
    const limitedProducts = products.slice(0, limit);

    return {
      ok: true,
      data: limitedProducts,
      metadata: metadataFrom(
        [provenance],
        warnings,
        'lidl',
        LIDL_PROVIDER,
        'Lidl data is sourced from the Lidl Plus app API (weekly leaflet only).',
        'Lidl data is sourced from cached retailer observations.'
      ),
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

    const storesUrl = `${STORES_URL}?query=${encodeURIComponent(location)}`;
    const cacheKey = `lidl:stores:${location}`;

    const cached = await this.cache.get<unknown>(cacheKey, { allowStale: true });
    if (cached && !cached.isStale) {
      return this.parseStoreResult(cached.data, cached.provenance, [], filters.limit);
    }

    try {
      const result = await this.sourceClient.fetchJson<unknown>(storesUrl, {
        provider: LIDL_PROVIDER,
        chain: 'lidl',
        sourceType: 'retailer-web',
        confidence: 'medium',
      });

      const provenance = this.buildProvenance(storesUrl);
      const record = await this.cache.set(
        cacheKey,
        result.data,
        cacheableProvenance(provenance),
        this.cacheTtlMs
      );

      return this.parseStoreResult(
        result.data,
        liveProvenanceWithCacheExpiry(provenance, record.expiresAt),
        [],
        filters.limit
      );
    } catch (error) {
      const warning = warningFromError(error, storesUrl, `${LIDL_PROVIDER} store API fetch failed`, 'lidl', LIDL_PROVIDER);

      if (cached) {
        return this.parseStoreResult(
          cached.data,
          cached.provenance,
          [warning, staleCacheWarning(cached.provenance, 'lidl', LIDL_PROVIDER)],
          filters.limit
        );
      }

      return {
        ok: false,
        error: { code: warning.code, message: warning.message },
      };
    }
  }

  private parseStoreResult(
    data: unknown,
    provenance: SourceProvenance,
    warnings: SourceWarning[],
    limit?: number
  ): Result<NormalizedStore[]> {
    const parsed = parseLidlStoresResponse(data, provenance.sourceUrl ?? STORES_URL);
    const stores = parsed.map((s) => toNormalizedStore(s, provenance));
    const limitedStores = typeof limit === 'number' ? stores.slice(0, limit) : stores;

    return {
      ok: true,
      data: limitedStores,
      metadata: metadataFrom(
        [provenance],
        warnings,
        'lidl',
        LIDL_PROVIDER,
        'Lidl data is sourced from the Lidl Plus app API.',
        'Lidl data is sourced from cached retailer observations.'
      ),
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
