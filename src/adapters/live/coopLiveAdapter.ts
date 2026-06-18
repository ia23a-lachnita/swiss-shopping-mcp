import { FileTtlCache } from '../../cache/fileTtlCache.js';
import {
  CoopParsedProduct,
  CoopParsedStore,
  CoopSearchResponse,
  CoopStoresResponse,
  parseCoopSearchResponse,
  parseCoopStoresResponse,
} from '../../parsers/coop.js';
import { resolveLocationAsync } from '../../util/geo.js';
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

const COOP_PROVIDER = 'Coop';
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SEARCH_LIMIT = 20;
const BASE_URL = 'https://www.coop.ch/rest/v2/coopathome';
const IOS_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export interface CoopLiveAdapterOptions {
  cache: FileTtlCache;
  cacheTtlMs?: number;
  userAgent?: string;
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
    productUrl: product.productUrl,
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
  private readonly storeClient: SourceHttpClient;
  private readonly cacheTtlMs: number;

  public constructor(options: CoopLiveAdapterOptions) {
    this.cache = options.cache;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const userAgent = options.userAgent ?? process.env.SWISSGROCERIES_USER_AGENT_COOP ?? IOS_SAFARI_UA;
    this.sourceClient = new SourceHttpClient({ rateLimitPerHostMs: 500, userAgent });
    this.storeClient = new SourceHttpClient({ rateLimitPerHostMs: 500, userAgent: IOS_SAFARI_UA });
  }

  private buildProvenance(sourceUrl: string): SourceProvenance {
    return {
      provider: COOP_PROVIDER,
      chain: 'coop',
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
      return {
        ok: false,
        error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' },
      };
    }

    const limit = typeof filters.limit === 'number' ? filters.limit : DEFAULT_SEARCH_LIMIT;
    const searchUrl = `${BASE_URL}/products/search/${encodeURIComponent(query)}?currentPage=0&pageSize=${limit}&fields=FULL`;
    const cacheKey = `coop:search:${query}:${limit}`;

    const cached = await this.cache.get<CoopSearchResponse>(cacheKey, { allowStale: true });
    if (cached && !cached.isStale) {
      return this.parseSearchResult(cached.data, cached.provenance, [], filters, query, searchUrl);
    }

    try {
      const result = await this.sourceClient.fetchJson<CoopSearchResponse>(searchUrl, {
        provider: COOP_PROVIDER,
        chain: 'coop',
        sourceType: 'retailer-web',
        confidence: 'medium',
      });

      const provenance = this.buildProvenance(searchUrl);
      const record = await this.cache.set(
        cacheKey,
        result.data,
        cacheableProvenance(provenance),
        this.cacheTtlMs
      );

      return this.parseSearchResult(
        result.data,
        liveProvenanceWithCacheExpiry(provenance, record.expiresAt),
        [],
        filters,
        query,
        searchUrl
      );
    } catch (error) {
      const warning = warningFromError(error, searchUrl, `${COOP_PROVIDER} API fetch failed`, 'coop', COOP_PROVIDER);

      // Detect DataDome blocks
      if (this.isDataDomeError(error)) {
        warning.code = SourceWarningCode.SourceUnavailable;
        warning.message = `${COOP_PROVIDER}: DataDome bot protection active — try again later`;
      }

      if (cached) {
        return this.parseSearchResult(
          cached.data,
          cached.provenance,
          [warning, staleCacheWarning(cached.provenance, 'coop', COOP_PROVIDER)],
          filters,
          query,
          searchUrl
        );
      }

      return {
        ok: false,
        error: { code: warning.code, message: warning.message },
      };
    }
  }

  private parseSearchResult(
    data: CoopSearchResponse,
    provenance: SourceProvenance,
    warnings: SourceWarning[],
    filters: ProductSearchFilters,
    query: string,
    sourceUrl: string
  ): Result<NormalizedProduct[]> {
    const matchMode = filters.matchMode ?? 'balanced';
    const parsed = parseCoopSearchResponse(data, sourceUrl);
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
        'coop',
        COOP_PROVIDER,
        'Coop data is sourced from live retailer API endpoints.',
        'Coop data is sourced from cached retailer observations.'
      ),
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

    const point = await resolveLocationAsync(location);
    const lat = point?.latitude ?? 47.3769;
    const lon = point?.longitude ?? 8.5417;
    const storesUrl = `${BASE_URL}/locations/searchAroundCoordinates?latitude=${lat}&longitude=${lon}&radius=5000`;
    const cacheKey = `coop:stores:${location}`;

    const cached = await this.cache.get<CoopStoresResponse>(cacheKey, { allowStale: true });
    if (cached && !cached.isStale) {
      return this.parseStoreResult(cached.data, cached.provenance, [], filters.limit);
    }

    try {
      const result = await this.storeClient.fetchJson<CoopStoresResponse>(storesUrl, {
        provider: COOP_PROVIDER,
        chain: 'coop',
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
      const warning = warningFromError(error, storesUrl, `${COOP_PROVIDER} store API fetch failed`, 'coop', COOP_PROVIDER);

      if (this.isDataDomeError(error)) {
        warning.code = SourceWarningCode.SourceUnavailable;
        warning.message = `${COOP_PROVIDER}: DataDome bot protection active — try again later`;
      }

      if (cached) {
        return this.parseStoreResult(
          cached.data,
          cached.provenance,
          [warning, staleCacheWarning(cached.provenance, 'coop', COOP_PROVIDER)],
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
    data: CoopStoresResponse,
    provenance: SourceProvenance,
    warnings: SourceWarning[],
    limit?: number
  ): Result<NormalizedStore[]> {
    const parsed = parseCoopStoresResponse(data, provenance.sourceUrl ?? `${BASE_URL}/locations`);
    const stores = parsed.map((s) => toNormalizedStore(s, provenance));
    const limitedStores = typeof limit === 'number' ? stores.slice(0, limit) : stores;

    return {
      ok: true,
      data: limitedStores,
      metadata: metadataFrom(
        [provenance],
        warnings,
        'coop',
        COOP_PROVIDER,
        'Coop data is sourced from live retailer API endpoints.',
        'Coop data is sourced from cached retailer observations.'
      ),
    };
  }

  private isDataDomeError(error: unknown): boolean {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return msg.includes('datadome') || (msg.includes('403') && msg.includes('forbidden'));
    }
    return false;
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
