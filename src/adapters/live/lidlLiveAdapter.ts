import { FileTtlCache } from '../../cache/fileTtlCache.js';
import {
  LidlParsedProduct,
  LidlParsedStore,
  parseLidlProductPage,
  parseLidlSearchPage,
  parseLidlStoresResponse,
} from '../../parsers/lidl.js';
import { isAbortError, throwIfAborted } from '../../util/cancellation.js';
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
  AdapterCallOptions,
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
const HYDRATION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_HYDRATED_IDS = 3;
const DEFAULT_SEARCH_LIMIT = 20;
const LIDL_BASE_URL = 'https://www.lidl.ch';
const LIDL_PRODUCT_PATH_PATTERN = /\/p(\d{4,})\/?$/;
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
    productUrl: product.sourceUrl !== provenance.sourceUrl ? product.sourceUrl : undefined,
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

/** Accept a product page path or full URL and return the path, if usable. */
function productPagePath(id: string): string | undefined {
  if (!id.startsWith('http')) {
    return id || undefined;
  }
  try {
    return new URL(id).pathname;
  } catch {
    return undefined;
  }
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

  // Note this one goes out through bare `fetch`, not `SourceHttpClient`, so
  // before the signal existed it had no deadline of any kind. It now inherits
  // the chain budget from the fan-out.
  private async fetchHtml(url: string, options?: AdapterCallOptions): Promise<string> {
    const response = await fetch(url, {
      signal: options?.signal,
      headers: {
        'User-Agent': LIDL_PLUS_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.text();
  }

  private async searchProductsFromWebsite(
    query: string,
    options?: AdapterCallOptions
  ): Promise<LidlParsedProduct[]> {
    const searchUrl = `${SEARCH_URL}?q=${encodeURIComponent(query)}`;

    // Try server-side HTML scraping first (faster)
    try {
      const html = await this.fetchHtml(searchUrl, options);
      const products = parseLidlSearchPage(html, searchUrl);
      if (products.length > 0) return products;
    } catch (error) {
      // A cancelled scrape must not "fall through" to Playwright — that would
      // answer an abort by starting the most expensive path we have.
      if (isAbortError(error)) throw error;
      // Otherwise fall through to Playwright.
    }

    // Playwright has no AbortSignal in its API, so cancellation here is a
    // checkpoint before the expensive step rather than an interruption of one
    // already running. Checked at the boundary because that is where the cost
    // is: a browser render is seconds, the parse after it is milliseconds.
    throwIfAborted(options?.signal, `lidl search for "${query}"`);
    const { searchProducts } = await import('./lidlBrowser.js');
    const browserProducts = await searchProducts(query);
    throwIfAborted(options?.signal, `lidl search for "${query}"`);
    return browserProducts.map((bp) => ({
      id: bp.id,
      name: bp.name,
      brand: undefined,
      price: { current: bp.price ?? 0, currency: 'CHF' },
      category: bp.category,
      image: bp.image,
      sourceUrl: bp.url || searchUrl,
      productUrl: bp.url,
    }));
  }

  public async searchProducts(
    filters: ProductSearchFilters,
    options?: AdapterCallOptions
  ): Promise<Result<NormalizedProduct[]>> {
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
      const products = await this.searchProductsFromWebsite(query, options);
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
      // Cancellation is not a Lidl outage, and must not be answered with the
      // stale cache below as though the search had merely failed.
      if (isAbortError(error)) throw error;

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

  /**
   * Hydrate products for Lidl product page paths discovered via web search
   * (e.g. /p/de-CH/vollmilch/p10054750; full URLs are accepted too). Lidl's
   * website search cannot look up bare product IDs, but product pages are
   * server-rendered with schema.org JSON-LD, so each path maps to one direct
   * page fetch. Capped at 3 IDs per call; paths that do not resolve to a
   * parseable product page are silently skipped.
   */
  public async getProductsByIds(ids: string[]): Promise<Result<NormalizedProduct[]>> {
    const paths: string[] = [];
    const seenNumericIds = new Set<string>();
    for (const raw of ids) {
      const id = raw.trim();
      const path = productPagePath(id);
      const numericId = path?.match(LIDL_PRODUCT_PATH_PATTERN)?.[1];
      if (!path || !numericId || seenNumericIds.has(numericId)) continue;
      seenNumericIds.add(numericId);
      paths.push(path.startsWith('/') ? path : `/${path}`);
      if (paths.length >= MAX_HYDRATED_IDS) break;
    }
    if (paths.length === 0) {
      return { ok: true, data: [] };
    }

    const products: NormalizedProduct[] = [];
    const warnings: SourceWarning[] = [];

    // Sequential on purpose: keeps the load on lidl.ch predictable and the
    // per-ID stale-cache fallback simple.
    for (const path of paths) {
      const numericId = path.match(LIDL_PRODUCT_PATH_PATTERN)![1];
      const cacheKey = `lidl:product-by-id:${numericId}`;
      const cached = await this.cache.get<LidlParsedProduct>(cacheKey, { allowStale: true });
      if (cached && !cached.isStale) {
        products.push(toNormalizedProduct(cached.data, cached.provenance));
        continue;
      }

      const pageUrl = `${LIDL_BASE_URL}${path}`;
      try {
        const html = await this.fetchHtml(pageUrl);
        const product = parseLidlProductPage(html, pageUrl);
        if (!product) {
          continue;
        }
        const provenance = this.buildProvenance(product.sourceUrl);
        await this.cache.set(cacheKey, product, cacheableProvenance(provenance), HYDRATION_CACHE_TTL_MS);
        products.push(toNormalizedProduct(product, provenance));
      } catch (error) {
        if (cached) {
          products.push(toNormalizedProduct(cached.data, cached.provenance));
          warnings.push(staleCacheWarning(cached.provenance, 'lidl', LIDL_PROVIDER));
          continue;
        }
        warnings.push(
          warningFromError(error, pageUrl, `${LIDL_PROVIDER} product hydration failed`, 'lidl', LIDL_PROVIDER)
        );
      }
    }

    if (products.length === 0 && warnings.length > 0) {
      return { ok: false, error: { code: warnings[0].code, message: warnings[0].message } };
    }

    const provenance = products[0]?.provenance ?? this.buildProvenance(SEARCH_URL);
    return {
      ok: true,
      data: products,
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
