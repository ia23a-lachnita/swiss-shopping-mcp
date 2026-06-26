import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { LidlParsedProduct, LidlParsedStore, parseLidlSearchPage, parseLidlStoresResponse } from '../../parsers/lidl.js';
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
const SEARCH_URL = 'https://www.lidl.ch/q/de-CH/search';
const STORES_URL = 'https://stores.lidlplus.com/api/v4/CH';
const LIDL_PLUS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
  private readonly cacheTtlMs: number;

  public constructor(options: LidlLiveAdapterOptions) {
    this.cache = options.cache;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
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

  private async fetchHtml(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        'User-Agent': LIDL_PLUS_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.text();
  }

  private async searchProductsFromWebsite(query: string): Promise<LidlParsedProduct[]> {
    const searchUrl = `${SEARCH_URL}?q=${encodeURIComponent(query)}`;
    const html = await this.fetchHtml(searchUrl);
    return parseLidlSearchPage(html, searchUrl);
  }

  public async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
    const query = filters.query.trim();
    if (!query) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' } };
    }

    const limit = typeof filters.limit === 'number' ? filters.limit : DEFAULT_SEARCH_LIMIT;
    const cacheKey = `lidl:products:${query}:${limit}`;

    const cached = await this.cache.get<unknown>(cacheKey, { allowStale: true });
    if (cached && !cached.isStale) {
      return this.parseProductResult(cached.data, cached.provenance, [], filters);
    }

    try {
      const products = await this.searchProductsFromWebsite(query);
      const provenance = this.buildProvenance(SEARCH_URL);
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
        filters
      );
    } catch (error) {
      const warning = warningFromError(error, SEARCH_URL, `${LIDL_PROVIDER} search failed`, 'lidl', LIDL_PROVIDER);

      if (cached) {
        return this.parseProductResult(
          cached.data,
          cached.provenance,
          [warning, staleCacheWarning(cached.provenance, 'lidl', LIDL_PROVIDER)],
          filters
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
    filters: ProductSearchFilters
  ): Result<NormalizedProduct[]> {
    const matchMode = filters.matchMode ?? 'balanced';
    const parsed = Array.isArray(data) ? data as LidlParsedProduct[] : [];
    const products = parsed
      .map((p) => toNormalizedProduct(p, provenance))
      .filter((product) => productMatches(product, filters.query, filters))
      .sort((a, b) => sortProducts(a, b, filters.query, matchMode));

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
        'Lidl data is sourced from the Lidl.ch website search.',
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
      const response = await fetch(STORES_URL, {
        headers: {
          'User-Agent': LIDL_PLUS_UA,
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const provenance = this.buildProvenance(STORES_URL);
      const record = await this.cache.set(
        cacheKey,
        data,
        cacheableProvenance(provenance),
        DEFAULT_CACHE_TTL_MS
      );

      const allParsed = parseLidlStoresResponse(data, STORES_URL);
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
