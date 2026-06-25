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
const CAMPAIGN_DETAIL_URL = 'https://digital-leaflet.lidlplus.com/api/v1/CH/campaigns';
const STORES_URL = 'https://stores.lidlplus.com/api/v4/CH';
const LIDL_PLUS_UA = 'Lidl Plus/5.0.0 (Android; 14; SM-S928B)';
const MAX_CAMPAIGNS_TO_FETCH = 5;

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

function filterStoresByQuery(stores: LidlParsedStore[], query: string): LidlParsedStore[] {
  const q = query.toLowerCase().trim();
  return stores.filter((s) => {
    const name = s.name.toLowerCase();
    const address = s.address.toLowerCase();
    return name.includes(q) || address.includes(q);
  });
}

export class LidlLiveAdapter implements ChainAdapter {
  public readonly chain = 'lidl' as const;
  private readonly cache: FileTtlCache;
  private readonly sourceClient: SourceHttpClient;
  private readonly cacheTtlMs: number;
  private campaignProductsCache: { products: LidlParsedProduct[]; expires: number } | null = null;

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

  private async loadCampaignProducts(): Promise<LidlParsedProduct[]> {
    if (this.campaignProductsCache && Date.now() < this.campaignProductsCache.expires) {
      return this.campaignProductsCache.products;
    }

    try {
      // Step 1: Get campaign groups to extract campaign IDs
      const groupsResult = await this.sourceClient.fetchJson<unknown>(CAMPAIGNS_URL, {
        provider: LIDL_PROVIDER,
        chain: 'lidl',
        sourceType: 'retailer-web',
        confidence: 'medium',
      });

      const groupsData = groupsResult.data as Record<string, unknown>;
      const groups = Array.isArray(groupsData.groups) ? groupsData.groups : [];
      const campaignIds: string[] = [];
      for (const group of groups) {
        const g = group as Record<string, unknown>;
        const campaigns = Array.isArray(g.campaigns) ? g.campaigns : [];
        for (const c of campaigns) {
          const camp = c as Record<string, unknown>;
          if (typeof camp.id === 'string') campaignIds.push(camp.id);
        }
      }

      // Step 2: Fetch individual campaigns to get products
      const allProducts: LidlParsedProduct[] = [];
      const idsToFetch = campaignIds.slice(0, MAX_CAMPAIGNS_TO_FETCH);
      const detailUrl = CAMPAIGN_DETAIL_URL;

      const fetches = idsToFetch.map(async (id) => {
        try {
          const result = await this.sourceClient.fetchJson<unknown>(`${detailUrl}/${id}`, {
            provider: LIDL_PROVIDER,
            chain: 'lidl',
            sourceType: 'retailer-web',
            confidence: 'medium',
          });
          return parseLidlCampaignProducts(result.data, `${detailUrl}/${id}`);
        } catch {
          return [];
        }
      });

      const results = await Promise.all(fetches);
      for (const products of results) {
        allProducts.push(...products);
      }

      this.campaignProductsCache = {
        products: allProducts,
        expires: Date.now() + this.cacheTtlMs,
      };

      return allProducts;
    } catch {
      return [];
    }
  }

  public async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
    const query = filters.query.trim();
    if (!query) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' } };
    }

    const limit = typeof filters.limit === 'number' ? filters.limit : DEFAULT_SEARCH_LIMIT;
    const cacheKey = `lidl:products:${limit}`;

    const cached = await this.cache.get<unknown>(cacheKey, { allowStale: true });
    if (cached && !cached.isStale) {
      return this.parseProductResult(cached.data, cached.provenance, [], filters, query);
    }

    try {
      const products = await this.loadCampaignProducts();
      const provenance = this.buildProvenance(CAMPAIGNS_URL);
      const record = await this.cache.set(
        cacheKey,
        products,
        cacheableProvenance(provenance),
        this.cacheTtlMs
      );

      return this.parseProductResult(
        products,
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

    const cacheKey = 'lidl:stores:all';

    const cached = await this.cache.get<unknown>(cacheKey, { allowStale: true });
    if (cached && !cached.isStale) {
      const allParsed = parseLidlStoresResponse(cached.data, STORES_URL);
      const filtered = filterStoresByQuery(allParsed, location);
      const stores = filtered.map((s) => toNormalizedStore(s, this.buildProvenance(STORES_URL)));
      const limitedStores = typeof filters.limit === 'number' ? stores.slice(0, filters.limit) : stores;
      return { ok: true, data: limitedStores };
    }

    try {
      // v4 API returns ALL Swiss stores — no query parameter needed
      const result = await this.sourceClient.fetchJson<unknown>(STORES_URL, {
        provider: LIDL_PROVIDER,
        chain: 'lidl',
        sourceType: 'retailer-web',
        confidence: 'medium',
      });

      const provenance = this.buildProvenance(STORES_URL);
      const record = await this.cache.set(
        cacheKey,
        result.data,
        cacheableProvenance(provenance),
        DEFAULT_CACHE_TTL_MS
      );

      const allParsed = parseLidlStoresResponse(result.data, STORES_URL);
      const filtered = filterStoresByQuery(allParsed, location);
      const stores = filtered.map((s) =>
        toNormalizedStore(s, liveProvenanceWithCacheExpiry(provenance, record.expiresAt))
      );
      const limitedStores = typeof filters.limit === 'number' ? stores.slice(0, filters.limit) : stores;

      return { ok: true, data: limitedStores };
    } catch (error) {
      const warning = warningFromError(error, STORES_URL, `${LIDL_PROVIDER} store API fetch failed`, 'lidl', LIDL_PROVIDER);

      if (cached) {
        const allParsed = parseLidlStoresResponse(cached.data, STORES_URL);
        const filtered = filterStoresByQuery(allParsed, location);
        const stores = filtered.map((s) =>
          toNormalizedStore(s, this.buildProvenance(STORES_URL))
        );
        const limitedStores = typeof filters.limit === 'number' ? stores.slice(0, filters.limit) : stores;
        return { ok: true, data: limitedStores, metadata: { sourceWarnings: [warning] } };
      }

      return {
        ok: false,
        error: { code: warning.code, message: warning.message },
      };
    }
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
