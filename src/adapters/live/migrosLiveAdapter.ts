import { FileTtlCache } from '../../cache/fileTtlCache.js';
import {
  MigrosApiProduct,
  MigrosApiStore,
  MigrosParsedProduct,
  MigrosParsedStore,
  parseMigrosSearchResponse,
  parseMigrosStoresResponse,
} from '../../parsers/migros.js';
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
  getGuestToken,
  searchProducts as browserSearchProducts,
  fetchProductCards,
  fetchProductDetail as browserFetchProductDetail,
  searchStores as browserSearchStores,
  checkAvailability as browserCheckAvailability,
} from './migrosBrowser.js';
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

const MIGROS_PROVIDER = 'Migros';
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SEARCH_LIMIT = 20;
const SEARCH_URL = 'https://www.migros.ch/product-display/public/v2/products/search';
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
    nutrition: product.nutrition,
    allergens: product.allergens,
    ingredients: product.ingredients ? [product.ingredients] : undefined,
    provenance: { ...provenance, sourceUrl: product.sourceUrl },
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

  public async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
    const query = filters.query.trim();
    if (!query) {
      return {
        ok: false,
        error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' },
      };
    }

    const limit = typeof filters.limit === 'number' ? filters.limit : DEFAULT_SEARCH_LIMIT;
    const cacheKey = `migros:search:${query}:${limit}`;

    const cached = await this.cache.get<{ products: MigrosApiProduct[] }>(cacheKey, { allowStale: true });
    if (cached && !cached.isStale) {
      return this.parseSearchResult(cached.data, cached.provenance, [], filters, query);
    }

    try {
      const products = await this.searchAndFetchDetails(query, limit);
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
      const warning = warningFromError(error, SEARCH_URL, `${MIGROS_PROVIDER} API fetch failed`, 'migros', MIGROS_PROVIDER);

      if (this.isAuthError(error) && !this.authFailed) {
        this.invalidateAuth();
        try {
          const products = await this.searchAndFetchDetails(query, limit);
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
  private async searchAndFetchDetails(query: string, limit: number): Promise<MigrosApiProduct[]> {
    const token = await this.ensureAuth();

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
    // Fetch product details via Playwright browser
    const detailsResult = await fetchProductCards(uids, token);

    // Details returned as { "0": product, "1": product, ... }
    const detailsRecord = detailsResult as Record<string, unknown>;
    const products: MigrosApiProduct[] = [];
    for (const key of Object.keys(detailsRecord)) {
      const raw = detailsRecord[key];
      if (raw && typeof raw === 'object') {
        products.push(this.normalizeProductDetail(raw));
      }
    }

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

          // Parse nutrition from nutrientsTable
          const rows = pi.nutrientsInformation?.nutrientsTable?.rows;
          if (rows && Array.isArray(rows)) {
            const parseFirst = (label: string): number | undefined => {
              const row = rows.find(r => r.label === label);
              if (!row?.values?.[0]) return undefined;
              const match = String(row.values[0]).match(/([\d.,]+)/);
              return match ? parseFloat(match[1].replace(',', '.')) : undefined;
            };
            product.nutrition_facts = {
              energy_kcal: (() => {
                const energyRow = rows.find(r => r.label === 'Energie');
                if (!energyRow?.values?.[0]) return undefined;
                const match = String(energyRow.values[0]).match(/\((\d+)\s*kcal\)/);
                return match ? parseInt(match[1], 10) : undefined;
              })(),
              protein: parseFirst('Eiweiss'),
              carbohydrates: parseFirst('Kohlenhydrate'),
              fat: parseFirst('Fett'),
              fiber: parseFirst('Ballaststoffe'),
              sugar: (() => {
                const sugarRow = rows.find(r => r.label === 'davon Zucker');
                if (!sugarRow?.values?.[0]) return undefined;
                const match = String(sugarRow.values[0]).match(/([\d.,]+)/);
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
    _filters: PromotionSearchFilters
  ): Promise<Result<NormalizedPromotion[]>> {
    return {
      ok: false,
      error: {
        code: SourceWarningCode.RealSourceNotImplemented,
        message: 'Migros promotions search is not yet implemented.',
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
    return raw.map((item) => {
      if (!item || typeof item !== 'object') return item as MigrosApiStore;
      const s = item as Record<string, unknown>;
      const loc = s.location as Record<string, unknown> | undefined;
      const addr = s.address as Record<string, unknown> | undefined;
      return {
        id: s.storeId ?? s.id ?? s.storeId,
        name: String(s.storeName ?? s.name ?? ''),
        latitude: typeof loc?.latitude === 'number' ? loc.latitude : undefined,
        longitude: typeof loc?.longitude === 'number' ? loc.longitude : undefined,
        opening_hours: this.parseOpeningHours(s.openingHours),
        city: String(addr?.city ?? s.city ?? s.town ?? ''),
        zip: String(addr?.zip ?? s.zip ?? s.postalCode ?? ''),
        street: String(addr?.street ?? s.street ?? ''),
        storeType: String(s.storeType ?? ''),
      } as unknown as MigrosApiStore;
    });
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
          const openTime = h.open.split(' ')[1]; // Extract "07:30" from "2026-06-20 07:30"
          const closeTime = h.close.split(' ')[1];
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
      // Step 1: Search for product to get its ID
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

      const product = productResult.data[0];
      const productId = product.id;

      // Step 2: Get nearby stores if no specific store requested
      let storeIds: string[];
      if (filters.storeId) {
        storeIds = [filters.storeId];
      } else {
        const storeResult = await this.findStores({ location: query, limit: 10 });
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
      return {
        ok: true,
        data: {
          chain: this.chain,
          storeId: filters.storeId,
          query,
          supported: false,
          matches: [],
          isAvailable: false,
          reason: warning.message,
        },
      };
    }
  }
}
