import { FileTtlCache } from '../../cache/fileTtlCache.js';
import {
  MigrosApiProduct,
  MigrosApiStore,
  MigrosParsedProduct,
  MigrosParsedPromotion,
  MigrosParsedStore,
  parseMigrosSearchResponse,
  parseMigrosStoresResponse,
  toParsedMigrosPromotion,
} from '../../parsers/migros.js';
import { calculateMatchStrength, sortProducts } from '../../util/matcher.js';
import {
  cacheableProvenance,
  liveProvenanceWithCacheExpiry,
  metadataFrom,
  productMatches,
  staleCacheWarning,
  warningFromError,
} from './baseLiveAdapter.js';
import {
  getGuestToken,
  migrosFetch,
  searchProducts as browserSearchProducts,
  fetchProductCards,
  fetchProductCardsByMigrosIds,
  fetchProductDetail as browserFetchProductDetail,
  searchStores as browserSearchStores,
  checkAvailability as browserCheckAvailability,
} from './migrosBrowser.js';
import { isAbortError, throwIfAborted } from '../../util/cancellation.js';
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
  StoreAvailabilitySupport,
  StoreProductAvailabilityFilters,
  StoreProductAvailabilityResult,
  StoreSearchFilters,
} from '../types.js';

const MIGROS_PROVIDER = 'Migros';
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SEARCH_LIMIT = 20;
const SEARCH_URL = 'https://www.migros.ch/product-display/public/v2/products/search';
const PROMOTION_SEARCH_URL = 'https://www.migros.ch/product-display/public/web/v2/products/promotion/search';
const DEFAULT_PROMOTION_LIMIT = 60;
const PRODUCT_CARDS_URL = 'https://www.migros.ch/product-display/public/v4/product-cards';
const STORES_URL = 'https://www.migros.ch/store/public/v1/stores/search';
const AVAILABILITY_URL = 'https://www.migros.ch/store-availability/public/v2/availabilities/products';

export interface MigrosLiveAdapterOptions {
  cache: FileTtlCache;
  cacheTtlMs?: number;
  regionId?: string;
  language?: string;
}

function toNormalizedProduct(
  product: MigrosParsedProduct,
  provenance: SourceProvenance
): NormalizedProduct {
  return {
    id: product.id,
    chain: 'migros',
    name: product.name,
    brand: product.brand,
    price: {
      current: product.price.current,
      original: product.original,
      unit: product.unit,
      vendorUnitPrice: product.vendorUnitPrice,
    },
    size: product.size,
    category: product.category,
    image: product.image,
    productUrl: product.productUrl,
    promotionLabel: product.promotionLabel,
    nutrition: product.nutrition,
    allergens: product.allergens,
    ingredients: product.ingredients ? [product.ingredients] : undefined,
    provenance: { ...provenance, sourceUrl: product.sourceUrl },
  };
}

function toNormalizedMigrosPromotion(
  promotion: MigrosParsedPromotion,
  provenance: SourceProvenance
): NormalizedPromotion {
  return {
    id: promotion.id,
    chain: 'migros',
    title: promotion.title,
    productName: promotion.title,
    brand: promotion.brand,
    category: promotion.category,
    description: promotion.description,
    image: promotion.image,
    price: promotion.price,
    originalPrice: promotion.originalPrice,
    discount: promotion.discount,
    validFrom: new Date(promotion.validFrom),
    validUntil: new Date(promotion.validUntil),
    provenance: { ...provenance, sourceUrl: promotion.sourceUrl },
  };
}

function promotionAsProduct(promotion: NormalizedPromotion): NormalizedProduct {
  const discount = promotion.discount;
  const label = discount
    ? discount.type === 'percentage' ? `${discount.value}%` : `-CHF ${discount.value.toFixed(2)}`
    : promotion.title;
  return {
    id: promotion.id,
    chain: promotion.chain,
    name: promotion.productName ?? promotion.title,
    brand: promotion.brand,
    category: promotion.category,
    size: promotion.description,
    price: {
      current: promotion.price?.current ?? Number.POSITIVE_INFINITY,
      original: promotion.originalPrice,
    },
    promotionLabel: label,
    tags: ['promotion'],
  };
}

function toNormalizedStore(
  store: MigrosParsedStore,
  provenance: SourceProvenance
): NormalizedStore {
  return {
    id: store.id,
    chain: 'migros',
    name: store.name,
    address: store.address,
    location: { latitude: store.latitude, longitude: store.longitude },
    openingHours: store.openingHours,
    provenance: { ...provenance, sourceUrl: store.sourceUrl },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractIdsFromNested(obj: Record<string, unknown>): number[] {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val)) {
      return val.map((item: unknown) => {
        const r = item as Record<string, unknown>;
        return (r.uid ?? r.id ?? r.productId ?? r.migrosId ?? r.migrosOnlineId) as number;
      }).filter((id): id is number => typeof id === 'number');
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const nested = extractIdsFromNested(val as Record<string, unknown>);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

export class MigrosLiveAdapter implements ChainAdapter {
  public readonly chain = 'migros' as const;
  private readonly cache: FileTtlCache;
  private readonly cacheTtlMs: number;
  private readonly language: string;
  private guestToken: string | null = null;
  private authFailed = false;

  public constructor(options: MigrosLiveAdapterOptions) {
    this.cache = options.cache;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.language = options.language ?? 'en';
  }

  private async ensureAuth(): Promise<string> {
    if (this.guestToken && !this.authFailed) {
      return this.guestToken;
    }
    try {
      // Fetch guest token via Playwright browser (bypasses Cloudflare)
      const token = await getGuestToken();
      this.guestToken = token;
      this.authFailed = false;
      return token;
    } catch (error) {
      this.authFailed = true;
      throw error;
    }
  }

  private invalidateAuth(): void {
    this.guestToken = null;
    this.authFailed = false;
  }

  private buildProvenance(sourceUrl: string): SourceProvenance {
    return {
      provider: MIGROS_PROVIDER,
      chain: 'migros',
      sourceType: 'retailer-web',
      sourceUrl,
      observedAt: new Date().toISOString(),
      freshness: 'live',
      confidence: 'medium',
    };
  }

  public async searchProducts(
    filters: ProductSearchFilters,
    options?: AdapterCallOptions
  ): Promise<Result<NormalizedProduct[]>> {
    const query = filters.query.trim();
    if (!query) {
      return {
        ok: false,
        error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' },
      };
    }

    const limit = typeof filters.limit === 'number' ? filters.limit : DEFAULT_SEARCH_LIMIT;
    // Normalize cache key: ignore limit so inner availability lookups (limit:1) reuse outer search results (limit:5)
    const cacheKey = `migros:search:${query}`;

    const cached = await this.cache.get<{ products: MigrosApiProduct[] }>(cacheKey, { allowStale: true });
    if (cached && !cached.isStale) {
      return this.parseSearchResult(cached.data, cached.provenance, [], filters, query);
    }

    try {
      const products = await this.searchAndFetchDetails(query, limit, options);
      const provenance = this.buildProvenance(SEARCH_URL);

      const record = await this.cache.set(
        cacheKey,
        { products },
        cacheableProvenance(provenance),
        this.cacheTtlMs
      );

      return this.parseSearchResult(
        { products },
        liveProvenanceWithCacheExpiry(provenance, record.expiresAt),
        [],
        filters,
        query
      );
    } catch (error) {
      // Before the auth-retry and the stale-cache fallback below: a cancelled
      // search must not re-authenticate and run the whole Playwright sequence
      // a second time, and must not be answered with stale cache as though
      // Migros had failed.
      if (isAbortError(error)) throw error;

      const warning = warningFromError(error, SEARCH_URL, `${MIGROS_PROVIDER} API fetch failed`, 'migros', MIGROS_PROVIDER);

      if (this.isAuthError(error) && !this.authFailed) {
        this.invalidateAuth();
        try {
          const products = await this.searchAndFetchDetails(query, limit, options);
          const provenance = this.buildProvenance(SEARCH_URL);
          const record = await this.cache.set(cacheKey, { products }, cacheableProvenance(provenance), this.cacheTtlMs);
          return this.parseSearchResult({ products }, liveProvenanceWithCacheExpiry(provenance, record.expiresAt), [], filters, query);
        } catch {
          // Fall through to stale cache
        }
      }

      if (cached) {
        return this.parseSearchResult(
          cached.data,
          cached.provenance,
          [warning, staleCacheWarning(cached.provenance, 'migros', MIGROS_PROVIDER)],
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  /**
   * Cancellation here is *checkpointed*, not interruptive, and that is a real
   * limitation rather than an oversight.
   *
   * Playwright exposes no `AbortSignal` on `page.goto`/`waitForSelector`. The
   * usual answer — close the page from an abort listener, which does tear down
   * the in-flight navigation — is not available: this adapter drives one
   * module-level shared page (`migrosBrowser.ts`), because that page holds the
   * cleared Cloudflare session, so closing it to cancel one search would break
   * every concurrent and subsequent search. Moving to a page per call would
   * mean re-clearing Cloudflare each time, which is the cost the singleton
   * exists to avoid.
   *
   * So each browser step runs to completion and the signal is checked between
   * them. Worst case after an abort is one outstanding browser round-trip
   * instead of the whole four-step sequence plus twenty enrichment fetches.
   */
  private async searchAndFetchDetails(
    query: string,
    limit: number,
    options?: AdapterCallOptions
  ): Promise<MigrosApiProduct[]> {
    const context = `migros search for "${query}"`;
    throwIfAborted(options?.signal, context);
    const token = await this.ensureAuth();
    throwIfAborted(options?.signal, context);

    // Search via Playwright browser (bypasses Cloudflare)
    const searchResult = await browserSearchProducts(query, {
      language: this.language,
      storeType: 'OFFLINE',
      region: 'national',
      limit,
      token,
    });

    // Search returns items with IDs, not full product data — fetch details
    const searchRecord = searchResult as Record<string, unknown>;
    const productIds: number[] =
      (Array.isArray(searchRecord.items)
        ? searchRecord.items.map((i: unknown) => (i as Record<string, unknown>).id as number).filter((id): id is number => typeof id === 'number')
        : Array.isArray(searchRecord.productIds) ? searchRecord.productIds :
       Array.isArray(searchRecord.hits) ? searchRecord.hits.map((h: unknown) => (h as Record<string, unknown>).uid ?? (h as Record<string, unknown>).id) :
       Array.isArray(searchRecord.data) ? searchRecord.data.map((d: unknown) => (d as Record<string, unknown>).uid ?? (d as Record<string, unknown>).id) :
       Array.isArray(searchRecord.results) ? searchRecord.results.map((r: unknown) => (r as Record<string, unknown>).uid ?? (r as Record<string, unknown>).id ?? (r as Record<string, unknown>).productId) :
       extractIdsFromNested(searchRecord)) as number[];
    if (productIds.length === 0) return [];

    const uids = productIds.slice(0, limit).map(Number);
    throwIfAborted(options?.signal, context);
    // Fetch product details via Playwright browser
    const products = await this.fetchCards(uids, token);
    throwIfAborted(options?.signal, context);

    // Fetch nutrition/ingredients from MGB endpoint for each product (in parallel, max 20)
    const enrichable = products.filter(p => p.id && !p.nutrition_facts).slice(0, 20);
    console.log(`[Migros] Enriching ${enrichable.length} products with nutrition data`);
    await Promise.all(
      enrichable.map(async (product) => {
        try {
          const migrosId = String((product as unknown as Record<string, unknown>).migrosId ?? product.id);
          console.log(`[Migros] Fetching MGB detail for product ${product.id} (migrosId: ${migrosId})`);
          const detail = await browserFetchProductDetail(migrosId, token) as {
            productInformation?: {
              nutrientsInformation?: {
                nutrientsTable?: {
                  headers?: string[];
                  rows?: Array<{ label: string; values: string[] }>;
                };
              };
              mainInformation?: {
                allergens?: string;
                ingredients?: string;
              };
            };
          };
          const pi = detail?.productInformation;
          if (!pi) return;

          // Parse nutrition from nutrientsTable. The table's first column is
          // usually (but not guaranteed to be) the per-100g/100ml basis — it
          // can also lead with a per-portion column (e.g. "1 Portion (25 g)")
          // depending on the product. Locate the per-100 column explicitly by
          // its header instead of assuming a fixed index, so values are
          // never silently mislabeled as "per 100g" when they aren't.
          const table = pi.nutrientsInformation?.nutrientsTable;
          const rows = table?.rows;
          const per100Index = Array.isArray(table?.headers)
            ? table.headers.findIndex((h) => /^100\s*(g|ml)$/i.test(String(h).trim()))
            : -1;
          if (rows && Array.isArray(rows) && per100Index !== -1) {
            const parseFirst = (label: string): number | undefined => {
              const row = rows.find(r => r.label === label);
              const raw = row?.values?.[per100Index];
              if (!raw) return undefined;
              const match = String(raw).match(/([\d.,]+)/);
              return match ? parseFloat(match[1].replace(',', '.')) : undefined;
            };
            product.nutrition_facts = {
              energy_kcal: (() => {
                const energyRow = rows.find(r => r.label === 'Energie');
                const raw = energyRow?.values?.[per100Index];
                if (!raw) return undefined;
                const match = String(raw).match(/\((\d+)\s*kcal\)/);
                return match ? parseInt(match[1], 10) : undefined;
              })(),
              protein: parseFirst('Eiweiss'),
              carbohydrates: parseFirst('Kohlenhydrate'),
              fat: parseFirst('Fett'),
              fiber: parseFirst('Ballaststoffe'),
              sugar: (() => {
                const sugarRow = rows.find(r => r.label === 'davon Zucker');
                const raw = sugarRow?.values?.[per100Index];
                if (!raw) return undefined;
                const match = String(raw).match(/([\d.,]+)/);
                return match ? parseFloat(match[1].replace(',', '.')) : undefined;
              })(),
            };
          }

          // Parse allergens
          const allergensRaw = pi.mainInformation?.allergens;
          if (typeof allergensRaw === 'string' && allergensRaw.length > 0) {
            product.allergens = allergensRaw.split(',').map((a: string) => a.trim()).filter(Boolean);
          }

          // Parse ingredients (if available) — strip HTML tags from MGB response
          const ingredientsRaw = pi.mainInformation?.ingredients;
          if (typeof ingredientsRaw === 'string' && ingredientsRaw.length > 0) {
            product.ingredients = ingredientsRaw.replace(/<[^>]*>/g, '');
          }
          console.log(`[Migros] Enriched product ${product.id}: nutrition=${!!product.nutrition_facts}, allergens=${!!product.allergens}`);
        } catch (e) {
          // Nutrition enrichment is best-effort; don't fail the search
          console.log(`[Migros] Failed to enrich product ${product.id}:`, e instanceof Error ? e.message : e);
        }
      })
    );

    return products;
  }

  private normalizeCards(detailsResult: unknown): MigrosApiProduct[] {
    // Details returned as { "0": product, "1": product, ... } or an array
    const detailsRecord = detailsResult as Record<string, unknown>;
    const products: MigrosApiProduct[] = [];
    for (const key of Object.keys(detailsRecord)) {
      const raw = detailsRecord[key];
      if (raw && typeof raw === 'object') {
        products.push(this.normalizeProductDetail(raw));
      }
    }
    return products;
  }

  private async fetchCards(uids: number[], token: string): Promise<MigrosApiProduct[]> {
    return this.normalizeCards(await fetchProductCards(uids, token));
  }

  public async getProductsByIds(ids: string[]): Promise<Result<NormalizedProduct[]>> {
    // Product page URLs carry migrosIds (12-digit, possibly with leading
    // zeros) — keep them as strings; product-cards `uids` does not accept them.
    const migrosIds = [...new Set(ids.map((id) => id.trim()).filter((id) => /^\d+$/.test(id)))];
    if (migrosIds.length === 0) {
      return { ok: true, data: [] };
    }

    const cacheKey = `migros:cards:${[...migrosIds].sort().join(',')}`;
    const cached = await this.cache.get<{ products: MigrosApiProduct[] }>(cacheKey, { allowStale: true });
    if (cached && !cached.isStale) {
      return this.parseHydratedProducts(cached.data.products, migrosIds, cached.provenance, []);
    }

    try {
      const token = await this.ensureAuth();
      const products = this.normalizeCards(await fetchProductCardsByMigrosIds(migrosIds, token));
      const provenance = this.buildProvenance(PRODUCT_CARDS_URL);

      const record = await this.cache.set(
        cacheKey,
        { products },
        cacheableProvenance(provenance),
        this.cacheTtlMs
      );

      return this.parseHydratedProducts(
        products,
        migrosIds,
        liveProvenanceWithCacheExpiry(provenance, record.expiresAt),
        []
      );
    } catch (error) {
      const warning = warningFromError(error, PRODUCT_CARDS_URL, `${MIGROS_PROVIDER} product cards fetch failed`, 'migros', MIGROS_PROVIDER);

      if (this.isAuthError(error) && !this.authFailed) {
        this.invalidateAuth();
        try {
          const token = await this.ensureAuth();
          const products = this.normalizeCards(await fetchProductCardsByMigrosIds(migrosIds, token));
          const provenance = this.buildProvenance(PRODUCT_CARDS_URL);
          const record = await this.cache.set(cacheKey, { products }, cacheableProvenance(provenance), this.cacheTtlMs);
          return this.parseHydratedProducts(products, migrosIds, liveProvenanceWithCacheExpiry(provenance, record.expiresAt), []);
        } catch {
          // Fall through to stale cache
        }
      }

      if (cached) {
        return this.parseHydratedProducts(
          cached.data.products,
          migrosIds,
          cached.provenance,
          [warning, staleCacheWarning(cached.provenance, 'migros', MIGROS_PROVIDER)]
        );
      }

      return {
        ok: false,
        error: { code: warning.code, message: warning.message },
      };
    }
  }

  private parseHydratedProducts(
    data: MigrosApiProduct[],
    orderedIds: string[],
    provenance: SourceProvenance,
    warnings: SourceWarning[]
  ): Result<NormalizedProduct[]> {
    const parsed = parseMigrosSearchResponse(data, provenance.sourceUrl ?? PRODUCT_CARDS_URL);

    // Preserve the caller's ID order (web-search rank). Callers pass
    // migrosIds; products are keyed by both uid and migrosId so either
    // namespace round-trips. Unmatched products are appended at the end.
    const byId = new Map<string, MigrosParsedProduct>();
    for (const p of parsed) {
      byId.set(p.id, p);
      if (p.migrosId !== undefined) {
        byId.set(String(p.migrosId), p);
      }
    }

    const orderedParsed: MigrosParsedProduct[] = [];
    const used = new Set<MigrosParsedProduct>();
    for (const id of orderedIds) {
      const product = byId.get(id);
      if (product && !used.has(product)) {
        orderedParsed.push(product);
        used.add(product);
      }
    }
    for (const product of parsed) {
      if (!used.has(product)) {
        orderedParsed.push(product);
        used.add(product);
      }
    }

    const ordered = orderedParsed.map((p) => toNormalizedProduct(p, provenance));

    return {
      ok: true,
      data: ordered,
      metadata: metadataFrom(
        [provenance],
        warnings,
        'migros',
        MIGROS_PROVIDER,
        'Migros data is sourced from live retailer API endpoints.',
        'Migros data is sourced from cached retailer observations.'
      ),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private normalizeProductDetail(raw: any): MigrosApiProduct {
    const offer = raw.offer ?? {};
    const priceData = offer.price ?? {};
    const unitPriceData = priceData.unitPrice ?? {};
    const promoPriceData = offer.promotionPrice ?? {};
    const images = raw.images ?? [];
    const firstImage = Array.isArray(images) ? images[0] : images;
    const imageUrl = typeof firstImage === 'string' ? firstImage : firstImage?.url ?? firstImage?.medium ?? '';
    const urls = raw.productUrls ?? [];
    const firstUrl = Array.isArray(urls) ? urls[0] : urls;
    const productUrl = typeof firstUrl === 'string' ? firstUrl : firstUrl?.url ?? '';

    // Determine effective price: use promotionPrice if available, otherwise effectiveValue
    const hasPromotion = promoPriceData && typeof promoPriceData.effectiveValue === 'number' && promoPriceData.effectiveValue > 0;
    const currentPrice = hasPromotion ? promoPriceData.effectiveValue : priceData.effectiveValue;
    const originalPrice = hasPromotion ? priceData.effectiveValue : undefined;

    // Extract promotion badges
    const badges = offer.badges;
    const promotionLabel = Array.isArray(badges)
      ? badges.map((b: { description?: string; type?: string }) => b.description).filter(Boolean).join(' ')
      : undefined;

    return {
      id: raw.uid ?? raw.migrosId ?? raw.migrosOnlineId ?? 0,
      name: raw.name ?? raw.title ?? '',
      brand_name: raw.brand ?? raw.brandName ?? '',
      price: {
        amount: typeof currentPrice === 'number' ? currentPrice : Number(currentPrice) || undefined,
        currency: 'CHF',
        unit: typeof unitPriceData.unit === 'string' ? unitPriceData.unit : undefined,
        vendorUnitPrice: typeof unitPriceData.value === 'number' && unitPriceData.value > 0
          ? { value: hasPromotion ? promoPriceData.unitPrice?.value ?? unitPriceData.value : unitPriceData.value, unit: unitPriceData.unit || '', display: offer.quantityPrice }
          : undefined,
        original: typeof originalPrice === 'number' ? originalPrice : undefined,
      },
      category_name: raw.primaryCategory?.name ?? raw.categoryName ?? '',
      image_url: imageUrl,
      url: productUrl,
      quantity: offer.quantity ?? raw.quantity ?? '',
      migrosId: raw.migrosId,
      promotionLabel,
    } as MigrosApiProduct;
  }

  private parseSearchResult(
    data: { products: MigrosApiProduct[] },
    provenance: SourceProvenance,
    warnings: SourceWarning[],
    filters: ProductSearchFilters,
    query: string
  ): Result<NormalizedProduct[]> {
    const matchMode = filters.matchMode ?? 'balanced';
    const parsed = parseMigrosSearchResponse(data.products, provenance.sourceUrl ?? SEARCH_URL);
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
        'migros',
        MIGROS_PROVIDER,
        'Migros data is sourced from live retailer API endpoints.',
        'Migros data is sourced from cached retailer observations.'
      ),
    };
  }

  public async searchPromotions(
    filters: PromotionSearchFilters
  ): Promise<Result<NormalizedPromotion[]>> {
    const query = filters.query.trim();
    if (!query) {
      return {
        ok: false,
        error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' },
      };
    }

    const loaded = await this.loadPromotions();
    if (!loaded.ok) {
      return {
        ok: true,
        data: [],
        metadata: {
          sourceWarnings: loaded.warnings,
          sources: [
            {
              chain: 'migros',
              status: 'degraded',
              provider: MIGROS_PROVIDER,
              sourceType: 'retailer-web',
              lastObservedAt: new Date().toISOString(),
              warning: loaded.warnings.at(0),
            },
          ],
          summary: 'Migros promotions are temporarily unavailable. Use product search instead.',
        },
      };
    }

    const matchMode = filters.matchMode ?? 'balanced';
    const promotions = loaded.data
      .filter((promotion) => {
        if (
          filters.category &&
          promotion.category?.toLowerCase() !== filters.category.toLowerCase()
        ) {
          return false;
        }
        if (
          typeof filters.maxPrice === 'number' &&
          (promotion.price?.current ?? Number.POSITIVE_INFINITY) > filters.maxPrice
        ) {
          return false;
        }
        return calculateMatchStrength(promotionAsProduct(promotion), query, matchMode) > 0;
      })
      .sort((a, b) => {
        const strengthDiff =
          calculateMatchStrength(promotionAsProduct(b), query, matchMode) -
          calculateMatchStrength(promotionAsProduct(a), query, matchMode);
        if (strengthDiff !== 0) {
          return strengthDiff;
        }
        return (
          (a.price?.current ?? Number.POSITIVE_INFINITY) -
          (b.price?.current ?? Number.POSITIVE_INFINITY)
        );
      });

    const limited =
      typeof filters.limit === 'number' ? promotions.slice(0, filters.limit) : promotions;
    return {
      ok: true,
      data: limited,
      metadata: metadataFrom(
        [loaded.provenance],
        loaded.warnings,
        'migros',
        MIGROS_PROVIDER,
        'Migros promotions are sourced from the live retailer campaign feed.',
        'Migros promotions are sourced from cached retailer observations.'
      ),
    };
  }

  private async loadPromotions(): Promise<
    | { ok: true; data: NormalizedPromotion[]; provenance: SourceProvenance; warnings: SourceWarning[] }
    | { ok: false; error: { code: string; message?: string }; warnings: SourceWarning[] }
  > {
    const cacheKey = 'migros:promotions:current';
    const cached = await this.cache.get<MigrosParsedPromotion[]>(cacheKey, { allowStale: true });
    if (cached && !cached.isStale) {
      return {
        ok: true,
        data: cached.data.map((p) => toNormalizedMigrosPromotion(p, cached.provenance)),
        provenance: cached.provenance,
        warnings: [],
      };
    }

    try {
      const token = await this.ensureAuth();
      const promotions = await this.fetchPromotionProducts(token);
      const provenance = this.buildProvenance(PROMOTION_SEARCH_URL);

      const record = await this.cache.set(
        cacheKey,
        promotions,
        cacheableProvenance(provenance),
        this.cacheTtlMs
      );
      const liveProvenance = liveProvenanceWithCacheExpiry(provenance, record.expiresAt);
      return {
        ok: true,
        data: promotions.map((p) => toNormalizedMigrosPromotion(p, liveProvenance)),
        provenance: liveProvenance,
        warnings: [],
      };
    } catch (error) {
      const warning = warningFromError(error, PROMOTION_SEARCH_URL, `${MIGROS_PROVIDER} promotions fetch failed`, 'migros', MIGROS_PROVIDER);

      if (this.isAuthError(error) && !this.authFailed) {
        this.invalidateAuth();
        try {
          const token = await this.ensureAuth();
          const promotions = await this.fetchPromotionProducts(token);
          const provenance = this.buildProvenance(PROMOTION_SEARCH_URL);
          const record = await this.cache.set(cacheKey, promotions, cacheableProvenance(provenance), this.cacheTtlMs);
          const liveProvenance = liveProvenanceWithCacheExpiry(provenance, record.expiresAt);
          return {
            ok: true,
            data: promotions.map((p) => toNormalizedMigrosPromotion(p, liveProvenance)),
            provenance: liveProvenance,
            warnings: [],
          };
        } catch {
          // Fall through to stale cache / error below
        }
      }

      if (cached) {
        return {
          ok: true,
          data: cached.data.map((p) => toNormalizedMigrosPromotion(p, cached.provenance)),
          provenance: cached.provenance,
          warnings: [warning, staleCacheWarning(cached.provenance, 'migros', MIGROS_PROVIDER)],
        };
      }

      return { ok: false, error: { code: warning.code, message: warning.message }, warnings: [warning] };
    }
  }

  private async fetchPromotionProducts(token: string): Promise<MigrosParsedPromotion[]> {
    const response = await migrosFetch(PROMOTION_SEARCH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        leshopch: token,
      },
      body: {
        storeType: 'OFFLINE',
        period: 'CURRENT',
        language: this.language,
        filters: {},
        sortFields: ['CATEGORYLEVEL'],
        sortOrder: 'asc',
        from: 0,
        until: DEFAULT_PROMOTION_LIMIT,
        region: 'national',
        warehouse: '1',
      },
    });

    if (response.status !== 200) {
      throw new Error(`Promotion search request failed with status ${response.status}`);
    }

    const data = response.data as {
      items?: Array<{ id: number; type?: string }>;
      startDate?: string;
      endDate?: string;
    };
    const items = Array.isArray(data.items) ? data.items : [];
    const uids = items.map((i) => i.id).filter((id): id is number => typeof id === 'number');
    if (uids.length === 0) {
      return [];
    }

    // Campaign feed only gives one shared start/end for the whole batch, not
    // per-product ranges - fall back to a plain 7-day window from today if
    // either is missing, so a partial response still yields usable data.
    const now = new Date();
    const startDate = data.startDate ?? now.toISOString().slice(0, 10);
    const endDate =
      data.endDate ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const cards = await this.fetchCards(uids, token);
    return cards.flatMap((product) => {
      const parsed = toParsedMigrosPromotion(product, { startDate, endDate }, PROMOTION_SEARCH_URL);
      return parsed ? [parsed] : [];
    });
  }

  public async findStores(filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
    const location = filters.location.trim();
    if (!location) {
      return {
        ok: false,
        error: { code: 'INVALID_QUERY', message: 'Location must be a non-empty string.' },
      };
    }

    const limit = typeof filters.limit === 'number' ? filters.limit : undefined;
    const cacheKey = `migros:stores:${location}:${limit ?? 'all'}`;

    const cached = await this.cache.get<{ stores: MigrosApiStore[] }>(cacheKey, { allowStale: true });
    if (cached && !cached.isStale) {
      return this.parseStoreResult(cached.data, cached.provenance, [], limit);
    }

    try {
      const token = await this.ensureAuth();
      // Search stores via Playwright browser (bypasses Cloudflare)
      const storeResult = await browserSearchStores(location, token);

      const stores = this.extractStoresFromResult(storeResult);
      const provenance = this.buildProvenance(STORES_URL);

      const record = await this.cache.set(
        cacheKey,
        { stores },
        cacheableProvenance(provenance),
        this.cacheTtlMs
      );

      return this.parseStoreResult(
        { stores },
        liveProvenanceWithCacheExpiry(provenance, record.expiresAt),
        [],
        limit
      );
    } catch (error) {
      const warning = warningFromError(error, STORES_URL, `${MIGROS_PROVIDER} store API fetch failed`, 'migros', MIGROS_PROVIDER);

      if (this.isAuthError(error) && !this.authFailed) {
        this.invalidateAuth();
        try {
          const token = await this.ensureAuth();
          const storeResultRetry = await browserSearchStores(location, token);
          const stores = this.extractStoresFromResult(storeResultRetry);
          const provenance = this.buildProvenance(STORES_URL);
          const record = await this.cache.set(cacheKey, { stores }, cacheableProvenance(provenance), this.cacheTtlMs);
          return this.parseStoreResult({ stores }, liveProvenanceWithCacheExpiry(provenance, record.expiresAt), [], limit);
        } catch {
          // Fall through to stale cache
        }
      }

      if (cached) {
        return this.parseStoreResult(
          cached.data,
          cached.provenance,
          [warning, staleCacheWarning(cached.provenance, 'migros', MIGROS_PROVIDER)],
          limit
        );
      }

      return {
        ok: false,
        error: { code: warning.code, message: warning.message },
      };
    }
  }

  private extractStoresFromResult(storeResult: unknown): MigrosApiStore[] {
    if (!storeResult || typeof storeResult !== 'object') return [];
    const result = storeResult as Record<string, unknown>;

    let raw: unknown[];
    if (Array.isArray(result.stores)) raw = result.stores;
    else if (Array.isArray(result.data)) raw = result.data;
    else if (Array.isArray(result.results)) raw = result.results;
    else if (Array.isArray(result)) raw = result;
    else if (Array.isArray(result.items)) raw = result.items;
    // Handle object with numeric keys: { "0": store, "1": store, ... }
    else if (typeof result === 'object' && !Array.isArray(result)) {
      const keys = Object.keys(result);
      if (keys.length > 0 && keys.every(k => /^\d+$/.test(k))) {
        raw = keys.map(k => result[k]);
      } else {
        return [];
      }
    }
    else return [];

    // Normalize Migros store format: { storeId, storeName, location: { latitude, longitude }, openingHours }
    // Only keep supermarket stores (mm, m, mmm) — exclude Migrolino, PickMup, VOI, etc.
    const SUPERMARKET_TYPES = new Set(['m', 'mm', 'mmm', '']);
    return raw.map((item) => {
      if (!item || typeof item !== 'object') return item as MigrosApiStore;
      const s = item as Record<string, unknown>;
      const loc = s.location as Record<string, unknown> | undefined;
      const addr = s.address as Record<string, unknown> | undefined;
      return {
        id: s.costCenterId ?? s.storeId ?? s.id,
        name: String(s.storeName ?? s.name ?? ''),
        latitude: typeof loc?.latitude === 'number' ? loc.latitude : undefined,
        longitude: typeof loc?.longitude === 'number' ? loc.longitude : undefined,
        opening_hours: this.parseOpeningHours(s.openingHours),
        city: String(addr?.city ?? s.city ?? s.town ?? ''),
        zip: String(addr?.zip ?? s.zip ?? s.postalCode ?? ''),
        street: String(addr?.street ?? s.street ?? ''),
        storeType: String(s.storeType ?? ''),
      } as unknown as MigrosApiStore;
    }).filter((store) => SUPERMARKET_TYPES.has(store.storeType ?? ''));
  }

  private parseOpeningHours(openingHours: unknown): string | undefined {
    if (!Array.isArray(openingHours) || openingHours.length === 0) return undefined;

    // Group hours by weekday/weekend
    const weekdayHours: string[] = [];
    const weekendHours: string[] = [];

    for (const entry of openingHours) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const dateStr = e.date as string;
      const hours = e.hours as Array<{ open?: string; close?: string; invalidated?: boolean }>;

      if (!dateStr || !Array.isArray(hours)) continue;

      const date = new Date(dateStr);
      const dayIndex = date.getDay();
      const isWeekend = dayIndex === 0 || dayIndex === 6;

      // Find valid hours (with open and close times)
      for (const h of hours) {
        if (h.open && h.close && !h.invalidated) {
          const openTime = h.open.includes(' ') ? h.open.split(' ')[1] : h.open;
          const closeTime = h.close.includes(' ') ? h.close.split(' ')[1] : h.close;
          const timeRange = `${openTime}-${closeTime}`;

          if (isWeekend) {
            if (!weekendHours.includes(timeRange)) weekendHours.push(timeRange);
          } else {
            if (!weekdayHours.includes(timeRange)) weekdayHours.push(timeRange);
          }
        }
      }
    }

    // Build formatted string
    const parts: string[] = [];
    if (weekdayHours.length > 0) {
      parts.push(`Mon-Fri: ${weekdayHours.join(', ')}`);
    }
    if (weekendHours.length > 0) {
      parts.push(`Sat-Sun: ${weekendHours.join(', ')}`);
    }

    return parts.length > 0 ? parts.join(' | ') : undefined;
  }

  private parseStoreResult(
    data: { stores: MigrosApiStore[] },
    provenance: SourceProvenance,
    warnings: SourceWarning[],
    limit?: number
  ): Result<NormalizedStore[]> {
    const parsed = parseMigrosStoresResponse(data.stores, provenance.sourceUrl ?? STORES_URL);
    const stores = parsed.map((s) => toNormalizedStore(s, provenance));
    const limitedStores = typeof limit === 'number' ? stores.slice(0, limit) : stores;

    return {
      ok: true,
      data: limitedStores,
      metadata: metadataFrom(
        [provenance],
        warnings,
        'migros',
        MIGROS_PROVIDER,
        'Migros data is sourced from live retailer API endpoints.',
        'Migros data is sourced from cached retailer observations.'
      ),
    };
  }

  private isAuthError(error: unknown): boolean {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden');
    }
    return false;
  }

  public getStoreAvailabilitySupport(): StoreAvailabilitySupport {
    return {
      chain: this.chain,
      supported: true,
    };
  }

  public async lookupStoreProductAvailability(
    filters: StoreProductAvailabilityFilters
  ): Promise<Result<StoreProductAvailabilityResult>> {
    const query = filters.query.trim();
    if (!query) {
      return {
        ok: true,
        data: {
          chain: this.chain,
          storeId: filters.storeId,
          query: filters.query,
          supported: false,
          matches: [],
          isAvailable: false,
        },
      };
    }

    try {
      // Step 1: Resolve the product. Prefer the caller-provided product (the
      // exact one already shown to the user) over re-searching `query`,
      // which can resolve to a different top match per call and would
      // otherwise get shared across every product being checked for a query.
      let product: NormalizedProduct;
      if (filters.product) {
        product = filters.product;
      } else {
        const productResult = await this.searchProducts({ query, limit: 1 });
        if (!productResult.ok || productResult.data.length === 0) {
          return {
            ok: true,
            data: {
              chain: this.chain,
              storeId: filters.storeId,
              query,
              supported: false,
              matches: [],
              isAvailable: false,
              reason: 'Product not found.',
            },
          };
        }
        product = productResult.data[0];
      }
      const productId = product.id;

      // Step 2: Get nearby stores if no specific store requested
      let storeIds: string[];
      if (filters.storeId) {
        storeIds = [filters.storeId];
      } else {
        // Use user coordinates if available, otherwise fall back to product query as location
        const storeLocation = (filters.userLatitude && filters.userLongitude)
          ? `${filters.userLatitude},${filters.userLongitude}`
          : query;
        const storeResult = await this.findStores({ location: storeLocation, limit: 10 });
        if (!storeResult.ok || storeResult.data.length === 0) {
          return {
            ok: true,
            data: {
              chain: this.chain,
              storeId: filters.storeId,
              query,
              supported: false,
              matches: [],
              isAvailable: false,
              reason: 'No nearby stores found.',
            },
          };
        }
        storeIds = storeResult.data.map((s) => s.id);
      }

      // Step 3: Call availability API via Playwright browser (bypasses Cloudflare)
      const token = await this.ensureAuth();
      const availabilityData = await browserCheckAvailability(productId, storeIds, token) as {
        availabilities: Array<{ id: string; stock: number }>;
        catalogItemId: number;
      };

      // Step 4: Build availability matches
      const matches = availabilityData.availabilities.map((avail) => ({
        product,
        available: avail.stock > 0,
        stockCount: avail.stock,
      }));

      const isAvailable = matches.some((m) => m.available);

      return {
        ok: true,
        data: {
          chain: this.chain,
          storeId: filters.storeId,
          query,
          supported: true,
          matches,
          isAvailable,
        },
      };
    } catch (error) {
      const warning = warningFromError(error, AVAILABILITY_URL, `${MIGROS_PROVIDER} availability API fetch failed`, 'migros', MIGROS_PROVIDER);
      const msg = error instanceof Error ? error.message : String(error);
      const is404 = msg.includes('status 404');
      return {
        ok: true,
        data: {
          chain: this.chain,
          storeId: filters.storeId,
          query,
          supported: !is404,
          matches: [],
          isAvailable: false,
          reason: warning.message,
        },
      };
    }
  }
}
