import { FileTtlCache } from '../../cache/fileTtlCache.js';
import {
  DennerParsedPromotion,
  DennerParsedProduct,
  parseDennerPromotionsPage,
  parseDennerSearchApiResponse,
  toNormalizedDennerPromotion,
} from '../../parsers/denner.js';
import { SourceClientError, SourceHttpClient } from '../../sources/sourceClient.js';
import { calculateMatchStrength, normalize } from '../../util/matcher.js';
import {
  ChainAdapter,
  NormalizedProduct,
  NormalizedPromotion,
  NormalizedStore,
  ProductSearchFilters,
  PromotionSearchFilters,
  Result,
  ResultMetadata,
  SourceProvenance,
  SourceStatus,
  SourceWarning,
  SourceWarningCode,
  StoreAvailabilitySupport,
  StoreProductAvailabilityFilters,
  StoreProductAvailabilityResult,
  StoreSearchFilters,
} from '../types.js';

const DENNER_PROVIDER = 'Denner';
const DENNER_ACTIONS_URL = 'https://www.denner.ch/de/aktionen/aktuelle-aktionen';
const DENNER_SEARCH_API_URL = 'https://www.denner.ch/search-api/simplePageContent';
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface LoadSuccess {
  ok: true;
  data: DennerParsedPromotion[];
  provenance: SourceProvenance;
  warnings: SourceWarning[];
}

interface LoadFailure {
  ok: false;
  error: {
    code: SourceWarningCode;
    message: string;
  };
  warnings: SourceWarning[];
}

type LoadResult = LoadSuccess | LoadFailure;

export interface DennerPromotionsAdapterOptions {
  delegate: ChainAdapter;
  cache: FileTtlCache;
  sourceClient?: SourceHttpClient;
  actionsUrl?: string;
  cacheTtlMs?: number;
  now?: () => Date;
}

function cacheableProvenance(
  provenance: SourceProvenance
): Omit<SourceProvenance, 'observedAt' | 'freshness' | 'cacheExpiresAt'> {
  return {
    provider: provenance.provider,
    chain: provenance.chain,
    sourceType: provenance.sourceType,
    sourceUrl: provenance.sourceUrl,
    confidence: provenance.confidence,
  };
}

function liveProvenanceWithCacheExpiry(
  provenance: SourceProvenance,
  cacheExpiresAt: string
): SourceProvenance {
  return {
    ...provenance,
    cacheExpiresAt,
  };
}

function promotionProvenance(
  promotion: DennerParsedPromotion,
  provenance: SourceProvenance
): SourceProvenance {
  return {
    ...provenance,
    sourceUrl: promotion.sourceUrl,
  };
}

function warningFromError(error: unknown, sourceUrl: string, messagePrefix: string): SourceWarning {
  if (error instanceof SourceClientError) {
    return {
      chain: 'denner',
      provider: DENNER_PROVIDER,
      sourceUrl: error.sourceUrl,
      code: error.code,
      message: `${messagePrefix}: ${error.message}`,
      observedAt: new Date().toISOString(),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    chain: 'denner',
    provider: DENNER_PROVIDER,
    sourceUrl,
    code: SourceWarningCode.SourceParseFailed,
    message: `${messagePrefix}: ${message}`,
    observedAt: new Date().toISOString(),
  };
}

function staleCacheWarning(provenance: SourceProvenance): SourceWarning {
  return {
    chain: 'denner',
    provider: DENNER_PROVIDER,
    sourceUrl: provenance.sourceUrl,
    code: SourceWarningCode.SourceStaleCacheUsed,
    message:
      'Using stale cached Denner promotion source data because the live source is unavailable.',
    observedAt: new Date().toISOString(),
  };
}

function metadataFrom(provenance: SourceProvenance, warnings: SourceWarning[]): ResultMetadata {
  const sources: SourceStatus[] = [
    {
      chain: 'denner',
      status:
        provenance.freshness === 'live'
          ? 'live-beta'
          : provenance.freshness === 'stale'
            ? 'degraded'
            : 'live-beta',
      provider: DENNER_PROVIDER,
      sourceType: 'retailer-web',
      lastObservedAt: provenance.observedAt,
      warning: warnings.at(0),
    },
  ];

  return {
    ...(warnings.length > 0 ? { sourceWarnings: warnings } : {}),
    sources,
    summary:
      provenance.freshness === 'stale'
        ? 'Denner promotions are sourced from cached retailer web observations.'
        : 'Denner promotions are sourced from retailer web action pages.',
  };
}

function revivePromotion(promotion: DennerParsedPromotion): DennerParsedPromotion {
  return {
    ...promotion,
    validFrom: new Date(promotion.validFrom),
    validUntil: new Date(promotion.validUntil),
  };
}

function promotionAsProduct(promotion: NormalizedPromotion): NormalizedProduct {
  return {
    id: promotion.id,
    chain: promotion.chain,
    name: promotion.productName ?? promotion.title,
    brand: promotion.brand,
    category: promotion.category,
    size: promotion.description,
    price: promotion.price ?? { current: Number.POSITIVE_INFINITY },
    tags: ['promotion'],
  };
}

export class DennerPromotionsAdapter implements ChainAdapter {
  public readonly chain = 'denner' as const;
  private readonly delegate: ChainAdapter;
  private readonly cache: FileTtlCache;
  private readonly sourceClient: SourceHttpClient;
  private readonly actionsUrl: string;
  private readonly cacheTtlMs: number;
  private readonly now: () => Date;

  public constructor(options: DennerPromotionsAdapterOptions) {
    this.delegate = options.delegate;
    this.cache = options.cache;
    this.sourceClient = options.sourceClient ?? new SourceHttpClient({ rateLimitPerHostMs: 1_000 });
    this.actionsUrl = options.actionsUrl ?? DENNER_ACTIONS_URL;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = options.now ?? ((): Date => new Date());
  }

  public async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
    const query = filters.query.trim();
    if (!query) {
      return {
        ok: false,
        error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' },
      };
    }

    const matchMode = filters.matchMode ?? 'balanced';
    const products: NormalizedProduct[] = [];
    const warnings: SourceWarning[] = [];

    const promotionResult = await this.searchProductsFromPromotions(filters);
    if (promotionResult.ok) {
      products.push(...promotionResult.data);
      if (promotionResult.metadata?.sourceWarnings) {
        warnings.push(...promotionResult.metadata.sourceWarnings);
      }
    }

    const searchResult = await this.searchProductsFromSearchApi(filters);
    if (searchResult.ok) {
      const existingIds = new Set(products.map((p) => p.id));
      for (const product of searchResult.data) {
        if (!existingIds.has(product.id)) {
          products.push(product);
        }
      }
      if (searchResult.metadata?.sourceWarnings) {
        warnings.push(...searchResult.metadata.sourceWarnings);
      }
    }

    const filtered = products
      .filter((product) => {
        if (typeof filters.maxPrice === 'number' && product.price.current > filters.maxPrice) {
          return false;
        }
        if (filters.category && normalize(product.category ?? '') !== normalize(filters.category)) {
          return false;
        }
        return calculateMatchStrength(product, query, matchMode) > 0;
      })
      .sort((a, b) => {
        const strengthDiff =
          calculateMatchStrength(b, query, matchMode) - calculateMatchStrength(a, query, matchMode);
        if (strengthDiff !== 0) return strengthDiff;
        return a.price.current - b.price.current;
      });

    const limitedProducts =
      typeof filters.limit === 'number' ? filtered.slice(0, filters.limit) : filtered;

    const provenance: SourceProvenance = {
      provider: DENNER_PROVIDER,
      chain: 'denner',
      sourceType: 'retailer-web',
      observedAt: new Date().toISOString(),
      freshness: 'live',
      confidence: 'medium',
    };

    return {
      ok: true,
      data: limitedProducts,
      metadata: {
        ...(warnings.length > 0 ? { sourceWarnings: warnings } : {}),
        sources: [
          {
            chain: 'denner',
            status: 'live-beta',
            provider: DENNER_PROVIDER,
            sourceType: 'retailer-web',
            lastObservedAt: provenance.observedAt,
          },
        ],
        summary: 'Denner products are sourced from retailer web pages and API.',
      },
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
              chain: 'denner',
              status: 'degraded',
              provider: DENNER_PROVIDER,
              sourceType: 'retailer-web',
              lastObservedAt: new Date().toISOString(),
              warning: loaded.warnings.at(0),
            },
          ],
          summary: 'Denner promotions are temporarily unavailable. Use product search instead.',
        },
      };
    }

    const matchMode = filters.matchMode ?? 'balanced';
    const now = this.now();
    const promotions = loaded.data
      .map((promotion) =>
        toNormalizedDennerPromotion(promotion, promotionProvenance(promotion, loaded.provenance))
      )
      .filter((promotion) => promotion.validUntil.getTime() >= now.getTime())
      .filter((promotion) => {
        if (
          filters.category &&
          normalize(promotion.category ?? '') !== normalize(filters.category)
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

    const limitedPromotions =
      typeof filters.limit === 'number' ? promotions.slice(0, filters.limit) : promotions;
    return {
      ok: true,
      data: limitedPromotions,
      metadata: metadataFrom(loaded.provenance, loaded.warnings),
    };
  }

  public async findStores(filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
    return this.delegate.findStores(filters);
  }

  public getStoreAvailabilitySupport(): StoreAvailabilitySupport {
    return this.delegate.getStoreAvailabilitySupport();
  }

  public async lookupStoreProductAvailability(
    filters: StoreProductAvailabilityFilters
  ): Promise<Result<StoreProductAvailabilityResult>> {
    return this.delegate.lookupStoreProductAvailability(filters);
  }

  private async loadPromotions(): Promise<LoadResult> {
    const cacheKey = `denner:promotions:${this.actionsUrl}`;
    const cached = await this.cache.get<DennerParsedPromotion[]>(cacheKey, { allowStale: true });
    if (cached && !cached.isStale) {
      return {
        ok: true,
        data: cached.data.map(revivePromotion),
        provenance: cached.provenance,
        warnings: [],
      };
    }

    try {
      const result = await this.sourceClient.fetchText(this.actionsUrl, {
        provider: DENNER_PROVIDER,
        chain: 'denner',
        sourceType: 'retailer-web',
        confidence: 'medium',
      });
      const promotions = parseDennerPromotionsPage(result.data, this.actionsUrl);
      const record = await this.cache.set(
        cacheKey,
        promotions,
        cacheableProvenance(result.provenance),
        this.cacheTtlMs
      );
      return {
        ok: true,
        data: promotions,
        provenance: liveProvenanceWithCacheExpiry(result.provenance, record.expiresAt),
        warnings: [],
      };
    } catch (error) {
      const warning = warningFromError(error, this.actionsUrl, 'Denner promotions fetch failed');
      if (cached) {
        return {
          ok: true,
          data: cached.data.map(revivePromotion),
          provenance: cached.provenance,
          warnings: [warning, staleCacheWarning(cached.provenance)],
        };
      }

      return {
        ok: false,
        error: { code: warning.code, message: warning.message },
        warnings: [warning],
      };
    }
  }

  private async searchProductsFromPromotions(
    filters: ProductSearchFilters
  ): Promise<Result<NormalizedProduct[]>> {
    const loaded = await this.loadPromotions();
    if (!loaded.ok) {
      return { ok: true, data: [] };
    }

    const matchMode = filters.matchMode ?? 'balanced';
    const query = filters.query;
    const products = loaded.data
      .map((p) => toNormalizedDennerPromotion(p, promotionProvenance(p, loaded.provenance)))
      .map((p) => promotionAsProduct(p))
      .filter((product) => {
        if (typeof filters.maxPrice === 'number' && product.price.current > filters.maxPrice) {
          return false;
        }
        return calculateMatchStrength(product, query, matchMode) > 0;
      });

    return { ok: true, data: products };
  }

  private async searchProductsFromSearchApi(
    filters: ProductSearchFilters
  ): Promise<Result<NormalizedProduct[]>> {
    const query = filters.query.trim();
    const cacheKey = `denner:search:${query}`;

    const cached = await this.cache.get<DennerParsedProduct[]>(cacheKey, { allowStale: true });
    if (cached && !cached.isStale) {
      return {
        ok: true,
        data: cached.data.map((p) => ({
          id: p.id,
          chain: 'denner' as const,
          name: p.name,
          brand: p.brand,
          category: p.category,
          price: p.price,
          image: p.image,
          productUrl: p.productUrl,
          size: p.size,
          tags: [],
        })),
      };
    }

    const sessionId = `denner-${Date.now()}`;
    const body = {
      moduleVersion: 'D2.0',
      sessionId,
      region: 'de_CH',
      advanced: { device: 'COMPUTER' },
      parameters: { query },
      pageId: 9,
    };

    try {
      const result = await this.sourceClient.fetchJson<unknown>(DENNER_SEARCH_API_URL, {
        provider: DENNER_PROVIDER,
        chain: 'denner',
        sourceType: 'retailer-web',
        confidence: 'medium',
        init: {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        },
      });
      const parsed = parseDennerSearchApiResponse(result.data);

      if (parsed.length > 0) {
        await this.cache.set(cacheKey, parsed, cacheableProvenance(result.provenance), this.cacheTtlMs);
      }

      return {
        ok: true,
        data: parsed.map((p) => ({
          id: p.id,
          chain: 'denner' as const,
          name: p.name,
          brand: p.brand,
          category: p.category,
          price: p.price,
          image: p.image,
          productUrl: p.productUrl,
          size: p.size,
          tags: [],
        })),
      };
    } catch {
      if (cached) {
        return {
          ok: true,
          data: cached.data.map((p) => ({
            id: p.id,
            chain: 'denner' as const,
            name: p.name,
            brand: p.brand,
            category: p.category,
            price: p.price,
            image: p.image,
            productUrl: p.productUrl,
            size: p.size,
            tags: [],
          })),
        };
      }
      return { ok: true, data: [] };
    }
  }
}
