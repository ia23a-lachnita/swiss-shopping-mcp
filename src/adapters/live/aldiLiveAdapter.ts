import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { AldiParsedProduct, AldiSitemapEntry, parseAldiProductPage, parseAldiProductSitemap } from '../../parsers/aldi.js';
import { SourceClientError, SourceHttpClient } from '../../sources/sourceClient.js';
import { calculateMatchStrength, normalize, sortProducts } from '../../util/matcher.js';
import {
  ChainAdapter,
  NormalizedProduct,
  ProductSearchFilters,
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

const ALDI_PROVIDER = 'ALDI SUISSE';
const ALDI_PRODUCT_SITEMAP_URL = 'https://www.aldi-suisse.ch/de/sitemap_products.xml';
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_PRODUCT_PAGES = 20;

interface LoadSuccess<T> {
  ok: true;
  data: T;
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

type LoadResult<T> = LoadSuccess<T> | LoadFailure;

export interface AldiLiveAdapterOptions {
  cache: FileTtlCache;
  sourceClient?: SourceHttpClient;
  productSitemapUrl?: string;
  cacheTtlMs?: number;
  maxProductPages?: number;
}

function cacheableProvenance(
  provenance: SourceProvenance,
): Omit<SourceProvenance, 'observedAt' | 'freshness' | 'cacheExpiresAt'> {
  return {
    provider: provenance.provider,
    chain: provenance.chain,
    sourceType: provenance.sourceType,
    sourceUrl: provenance.sourceUrl,
    confidence: provenance.confidence,
  };
}

function productProvenance(product: AldiParsedProduct, provenance: SourceProvenance): SourceProvenance {
  return {
    ...provenance,
    sourceUrl: product.sourceUrl,
  };
}

function liveProvenanceWithCacheExpiry(provenance: SourceProvenance, cacheExpiresAt: string): SourceProvenance {
  return {
    ...provenance,
    cacheExpiresAt,
  };
}

function toNormalizedProduct(product: AldiParsedProduct, provenance: SourceProvenance): NormalizedProduct {
  return {
    id: product.id,
    chain: 'aldi',
    name: product.name,
    brand: product.brand,
    price: {
      current: product.price.current,
    },
    category: product.category,
    image: product.image,
    tags: product.availability?.endsWith('/InStock') ? ['in-stock'] : undefined,
    provenance: productProvenance(product, provenance),
  };
}

function warningFromError(error: unknown, sourceUrl: string, messagePrefix: string): SourceWarning {
  if (error instanceof SourceClientError) {
    return {
      chain: 'aldi',
      provider: ALDI_PROVIDER,
      sourceUrl: error.sourceUrl,
      code: error.code,
      message: `${messagePrefix}: ${error.message}`,
      observedAt: new Date().toISOString(),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    chain: 'aldi',
    provider: ALDI_PROVIDER,
    sourceUrl,
    code: SourceWarningCode.SourceParseFailed,
    message: `${messagePrefix}: ${message}`,
    observedAt: new Date().toISOString(),
  };
}

function staleCacheWarning(provenance: SourceProvenance): SourceWarning {
  return {
    chain: 'aldi',
    provider: ALDI_PROVIDER,
    sourceUrl: provenance.sourceUrl,
    code: SourceWarningCode.SourceStaleCacheUsed,
    message: 'Using stale cached Aldi source data because the live source is unavailable.',
    observedAt: new Date().toISOString(),
  };
}

function metadataFrom(provenances: SourceProvenance[], warnings: SourceWarning[]): ResultMetadata {
  const primaryProvenance = provenances.find((provenance) => provenance.freshness === 'live') ?? provenances.at(0);
  const sources: SourceStatus[] = [
    {
      chain: 'aldi',
      status: primaryProvenance?.freshness === 'live' ? 'live-beta' : 'degraded',
      provider: ALDI_PROVIDER,
      sourceType: 'retailer-web',
      lastObservedAt: primaryProvenance?.observedAt,
      warning: warnings.at(0),
    },
  ];

  return {
    ...(warnings.length > 0 ? { sourceWarnings: warnings } : {}),
    sources,
    summary:
      primaryProvenance?.freshness === 'live'
        ? 'Aldi products are sourced from live retailer web pages.'
        : 'Aldi products are sourced from cached retailer web observations.',
  };
}

function queryTerms(query: string): string[] {
  return normalize(query)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
}

function isCandidateUrl(entry: AldiSitemapEntry, terms: string[]): boolean {
  if (terms.length === 0) {
    return false;
  }

  const normalizedUrl = normalize(entry.loc);
  return terms.some((term) => normalizedUrl.includes(term));
}

export class AldiLiveAdapter implements ChainAdapter {
  public readonly chain = 'aldi' as const;
  private readonly cache: FileTtlCache;
  private readonly sourceClient: SourceHttpClient;
  private readonly productSitemapUrl: string;
  private readonly cacheTtlMs: number;
  private readonly maxProductPages: number;

  public constructor(options: AldiLiveAdapterOptions) {
    this.cache = options.cache;
    this.sourceClient = options.sourceClient ?? new SourceHttpClient({ rateLimitPerHostMs: 1_000 });
    this.productSitemapUrl = options.productSitemapUrl ?? ALDI_PRODUCT_SITEMAP_URL;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxProductPages = options.maxProductPages ?? DEFAULT_MAX_PRODUCT_PAGES;
  }

  public async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
    const query = filters.query.trim();
    if (!query) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' } };
    }

    const sitemap = await this.loadSitemap();
    if (!sitemap.ok) {
      return { ok: false, error: sitemap.error };
    }

    const terms = queryTerms(query);
    const productPageLimit = Math.min(Math.max((filters.limit ?? 1) * 5, 5), this.maxProductPages);
    const candidates = sitemap.data.filter((entry) => isCandidateUrl(entry, terms)).slice(0, productPageLimit);
    const productResults = await Promise.all(candidates.map((entry) => this.loadProduct(entry.loc)));
    const warnings = [
      ...sitemap.warnings,
      ...productResults.flatMap((result) => result.warnings),
    ];
    const products = productResults
      .filter((result): result is LoadSuccess<AldiParsedProduct> => result.ok)
      .map((result) => toNormalizedProduct(result.data, result.provenance))
      .filter((product) => this.productMatches(product, query, filters))
      .sort((a, b) => sortProducts(a, b, query, filters.matchMode ?? 'balanced'));

    if (candidates.length > 0 && products.length === 0 && productResults.every((result) => !result.ok)) {
      return {
        ok: false,
        error: {
          code: SourceWarningCode.SourceUnavailable,
          message: warnings.map((warning) => warning.message).join('; '),
        },
      };
    }

    const provenances = [
      sitemap.provenance,
      ...productResults.filter((result): result is LoadSuccess<AldiParsedProduct> => result.ok).map((result) => result.provenance),
    ];
    const limitedProducts = typeof filters.limit === 'number' ? products.slice(0, filters.limit) : products;
    return {
      ok: true,
      data: limitedProducts,
      metadata: metadataFrom(provenances, warnings),
    };
  }

  public async findStores(_filters: StoreSearchFilters): Promise<Result<never[]>> {
    return {
      ok: false,
      error: {
        code: SourceWarningCode.RealSourceNotImplemented,
        message: 'Aldi live-beta adapter covers product search only; store lookup is not implemented.',
      },
    };
  }

  public getStoreAvailabilitySupport(): StoreAvailabilitySupport {
    return {
      chain: this.chain,
      supported: false,
      reason: 'Aldi live-beta adapter does not expose store-level product availability.',
    };
  }

  public async lookupStoreProductAvailability(
    filters: StoreProductAvailabilityFilters,
  ): Promise<Result<StoreProductAvailabilityResult>> {
    return {
      ok: true,
      data: {
        chain: this.chain,
        storeId: filters.storeId,
        query: filters.query,
        supported: false,
        reason: 'Aldi live-beta adapter does not expose store-level product availability.',
        matches: [],
        isAvailable: false,
      },
    };
  }

  private productMatches(product: NormalizedProduct, query: string, filters: ProductSearchFilters): boolean {
    const matchMode = filters.matchMode ?? 'balanced';
    if (calculateMatchStrength(product, query, matchMode) === 0) {
      return false;
    }

    if (typeof filters.maxPrice === 'number' && product.price.current > filters.maxPrice) {
      return false;
    }

    if (filters.category && normalize(product.category ?? '') !== normalize(filters.category)) {
      return false;
    }

    const requestedTags = (filters.tags ?? []).map((tag) => normalize(tag));
    const productTags = new Set((product.tags ?? []).map((tag) => normalize(tag)));
    return requestedTags.every((tag) => productTags.has(tag));
  }

  private async loadSitemap(): Promise<LoadResult<AldiSitemapEntry[]>> {
    const cacheKey = `aldi:product-sitemap:${this.productSitemapUrl}`;
    const cached = await this.cache.get<AldiSitemapEntry[]>(cacheKey, { allowStale: true });
    if (cached && !cached.isStale) {
      return { ok: true, data: cached.data, provenance: cached.provenance, warnings: [] };
    }

    try {
      const result = await this.sourceClient.fetchText(this.productSitemapUrl, {
        provider: ALDI_PROVIDER,
        chain: 'aldi',
        sourceType: 'retailer-web',
        confidence: 'high',
      });
      const entries = parseAldiProductSitemap(result.data);
      const record = await this.cache.set(cacheKey, entries, cacheableProvenance(result.provenance), this.cacheTtlMs);
      return {
        ok: true,
        data: entries,
        provenance: liveProvenanceWithCacheExpiry(result.provenance, record.expiresAt),
        warnings: [],
      };
    } catch (error) {
      const warning = warningFromError(error, this.productSitemapUrl, 'Aldi product sitemap fetch failed');
      if (cached) {
        return {
          ok: true,
          data: cached.data,
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

  private async loadProduct(sourceUrl: string): Promise<LoadResult<AldiParsedProduct>> {
    const cacheKey = `aldi:product-page:${sourceUrl}`;
    const cached = await this.cache.get<AldiParsedProduct>(cacheKey, { allowStale: true });
    if (cached && !cached.isStale) {
      return { ok: true, data: cached.data, provenance: cached.provenance, warnings: [] };
    }

    try {
      const result = await this.sourceClient.fetchText(sourceUrl, {
        provider: ALDI_PROVIDER,
        chain: 'aldi',
        sourceType: 'retailer-web',
        confidence: 'medium',
      });
      const product = parseAldiProductPage(result.data, sourceUrl);
      const record = await this.cache.set(cacheKey, product, cacheableProvenance(result.provenance), this.cacheTtlMs);
      return {
        ok: true,
        data: product,
        provenance: liveProvenanceWithCacheExpiry(result.provenance, record.expiresAt),
        warnings: [],
      };
    } catch (error) {
      const warning = warningFromError(error, sourceUrl, 'Aldi product page fetch failed');
      if (cached) {
        return {
          ok: true,
          data: cached.data,
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
}
