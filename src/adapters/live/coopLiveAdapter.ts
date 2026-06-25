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
const AVAILABILITY_URL = 'https://www.coop.ch/rest/v2/coopathome/products';

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
      const parsed = this.parseSearchResult(cached.data, cached.provenance, [], filters, query, searchUrl);
      // Enrich top 5 products with ingredients + nutrition via product detail API
      if (parsed.ok && parsed.data.length > 0) {
        const toEnrich = parsed.data.slice(0, 5);
        const enriched = await Promise.all(
          toEnrich.map(async (p) => {
            const detail = await this.fetchProductDetail(p.id);
            if (!detail) return p;
            return {
              ...p,
              ingredients: detail.ingredients ? [detail.ingredients] : p.ingredients,
              nutrition: detail.nutrition ?? p.nutrition,
            };
          })
        );
        const enrichedMap = new Map(enriched.map(p => [p.id, p]));
        parsed.data = parsed.data.map(p => enrichedMap.get(p.id) ?? p);
      }
      return parsed;
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

      const parsed = this.parseSearchResult(
        result.data,
        liveProvenanceWithCacheExpiry(provenance, record.expiresAt),
        [],
        filters,
        query,
        searchUrl
      );

      // Enrich top 5 products with ingredients + nutrition via product detail API
      if (parsed.ok && parsed.data.length > 0) {
        const toEnrich = parsed.data.slice(0, 5);
        const enriched = await Promise.all(
          toEnrich.map(async (p) => {
            const detail = await this.fetchProductDetail(p.id);
            if (!detail) return p;
            return {
              ...p,
              ingredients: detail.ingredients ? [detail.ingredients] : p.ingredients,
              nutrition: detail.nutrition ?? p.nutrition,
            };
          })
        );
        // Merge enriched back into results
        const enrichedMap = new Map(enriched.map(p => [p.id, p]));
        parsed.data = parsed.data.map(p => enrichedMap.get(p.id) ?? p);
      }

      return parsed;
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
    const storesUrl = `${BASE_URL}/locations/searchAroundCoordinates?latitude=${lat}&longitude=${lon}&currentPage=0`;
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

  private async fetchProductDetail(
    productCode: string
  ): Promise<{ ingredients?: string; nutrition?: NormalizedProduct['nutrition'] } | undefined> {
    try {
      const detailUrl = `${BASE_URL}/products/${productCode}?fields=FULL`;
      const result = await this.sourceClient.fetchJson<{
        ingredients?: string;
        nutritionInformation?: {
          nutrients?: Array<{ name: string; assembledValue: string }>;
          nutritionInformationPerUnit?: {
            nutrients?: Array<{ name: string; assembledValue: string }>;
          };
          nutritionInformationPerPortion?: {
            nutrients?: Array<{ name: string; assembledValue: string }>;
          };
        };
      }>(detailUrl, {
        provider: COOP_PROVIDER,
        chain: 'coop',
        sourceType: 'retailer-web',
        confidence: 'medium',
      });

      const data = result.data;
      if (!data) return undefined;

      // Parse ingredients: strip HTML tags
      let ingredients: string | undefined;
      if (typeof data.ingredients === 'string' && data.ingredients.length > 0) {
        ingredients = data.ingredients
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&#x25;/g, '%')
          .trim();
        if (ingredients.length === 0) ingredients = undefined;
      }

      // Parse nutrition from nutritionInformation (try multiple locations)
      let nutrition: NormalizedProduct['nutrition'] | undefined;
      const nutrients = data.nutritionInformation?.nutrients
        ?? data.nutritionInformation?.nutritionInformationPerUnit?.nutrients
        ?? data.nutritionInformation?.nutritionInformationPerPortion?.nutrients;
      if (nutrients && Array.isArray(nutrients) && nutrients.length > 0) {
        const parseNum = (raw: string): number | undefined => {
          const cleaned = raw.replace(/[^0-9.,]/g, '').replace(',', '.');
          const n = parseFloat(cleaned);
          return Number.isFinite(n) ? n : undefined;
        };

        let energyKcal: number | undefined;
        let fat: number | undefined;
        let carbs: number | undefined;
        let sugar: number | undefined;
        let protein: number | undefined;

        let energyCount = 0;
        for (const n of nutrients) {
          const name = (n.name || '').toLowerCase();
          if (name === 'energie') {
            energyCount++;
            if (energyCount === 2) {
              energyKcal = parseNum(n.assembledValue);
            }
          } else if (name === 'fett' && fat === undefined) {
            fat = parseNum(n.assembledValue);
          } else if ((name === 'kohlenhydrate' || name === 'kohlenhydrate') && carbs === undefined) {
            carbs = parseNum(n.assembledValue);
          } else if (name.startsWith('davon zucker') && sugar === undefined) {
            sugar = parseNum(n.assembledValue);
          } else if (name === 'eiweiss' && protein === undefined) {
            protein = parseNum(n.assembledValue);
          }
        }

        if (energyKcal !== undefined || fat !== undefined || carbs !== undefined || protein !== undefined) {
          nutrition = { energyKcal, protein, carbs, fat, sugar };
        }
      }

      if (!ingredients && !nutrition) return undefined;
      return { ingredients, nutrition };
    } catch {
      return undefined;
    }
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
      reason: 'Coop /products/{id}/stockLevels endpoint no longer exists (returns UnknownResourceError).',
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

      // Step 3: Call availability API
      const costCenterIds = storeIds.join(',');
      const availabilityUrl = `${AVAILABILITY_URL}/${productId}/stockLevels?costCenterIds=${costCenterIds}`;

      const result = await this.storeClient.fetchJson<{
        availabilities: Array<{ id: string; stock: number }>;
        catalogItemId: number;
      }>(availabilityUrl, {
        provider: COOP_PROVIDER,
        chain: 'coop',
        sourceType: 'retailer-web',
        confidence: 'medium',
      });

      // Step 4: Build availability matches
      const matches = result.data.availabilities.map((avail) => ({
        product,
        available: avail.stock > 0,
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
      const warning = warningFromError(error, AVAILABILITY_URL, `${COOP_PROVIDER} availability API fetch failed`, 'coop', COOP_PROVIDER);

      if (this.isDataDomeError(error)) {
        warning.code = SourceWarningCode.SourceUnavailable;
        warning.message = `${COOP_PROVIDER}: DataDome bot protection active — try again later`;
      }

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
