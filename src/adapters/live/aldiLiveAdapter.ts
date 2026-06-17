import { FileTtlCache } from '../../cache/fileTtlCache.js';
import {
  AldiParsedProduct,
  AldiSitemapEntry,
  parseAldiProductPage,
  parseAldiProductSitemap,
} from '../../parsers/aldi.js';
import { SourceHttpClient } from '../../sources/sourceClient.js';
import { normalize, sortProducts } from '../../util/matcher.js';
import {
  cacheableProvenance,
  liveProvenanceWithCacheExpiry,
  LoadResult,
  LoadSuccess,
  metadataFrom,
  productMatches,
  staleCacheWarning,
  warningFromError,
} from './baseLiveAdapter.js';
import {
  ChainAdapter,
  NormalizedProduct,
  ProductSearchFilters,
  PromotionSearchFilters,
  Result,
  SourceProvenance,
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

export interface AldiLiveAdapterOptions {
  cache: FileTtlCache;
  sourceClient?: SourceHttpClient;
  productSitemapUrl?: string;
  cacheTtlMs?: number;
  maxProductPages?: number;
}

function productProvenance(
  product: AldiParsedProduct,
  provenance: SourceProvenance
): SourceProvenance {
  return {
    ...provenance,
    sourceUrl: product.sourceUrl,
  };
}

function toNormalizedProduct(
  product: AldiParsedProduct,
  provenance: SourceProvenance
): NormalizedProduct {
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
    productUrl: product.sourceUrl,
    tags: product.availability?.endsWith('/InStock') ? ['in-stock'] : undefined,
    provenance: productProvenance(product, provenance),
  };
}

function queryTerms(query: string): string[] {
  return normalize(query)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
}

async function batchAll<T>(
  items: T[],
  fn: (item: T) => Promise<unknown>,
  concurrency: number
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    await Promise.all(batch.map(fn));
  }
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
      return {
        ok: false,
        error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' },
      };
    }

    const sitemap = await this.loadSitemap();
    if (!sitemap.ok) {
      return { ok: false, error: sitemap.error };
    }

    const terms = queryTerms(query);
    const productPageLimit = Math.min(Math.max((filters.limit ?? 1) * 5, 5), this.maxProductPages);
    const candidates = sitemap.data
      .filter((entry) => isCandidateUrl(entry, terms))
      .slice(0, productPageLimit);
    const productResults: LoadResult<AldiParsedProduct>[] = [];
    await batchAll(
      candidates,
      async (entry) => {
        const result = await this.loadProduct(entry.loc);
        productResults.push(result);
      },
      5
    );
    const warnings = [...sitemap.warnings, ...productResults.flatMap((result) => result.warnings)];
    const products = productResults
      .filter((result): result is LoadSuccess<AldiParsedProduct> => result.ok)
      .map((result) => toNormalizedProduct(result.data, result.provenance))
      .filter((product) => productMatches(product, query, filters))
      .sort((a, b) => sortProducts(a, b, query, filters.matchMode ?? 'balanced'));

    if (
      candidates.length > 0 &&
      products.length === 0 &&
      productResults.every((result) => !result.ok)
    ) {
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
      ...productResults
        .filter((result): result is LoadSuccess<AldiParsedProduct> => result.ok)
        .map((result) => result.provenance),
    ];
    const limitedProducts =
      typeof filters.limit === 'number' ? products.slice(0, filters.limit) : products;
    return {
      ok: true,
      data: limitedProducts,
      metadata: metadataFrom(
        provenances,
        warnings,
        'aldi',
        ALDI_PROVIDER,
        'Aldi products are sourced from live retailer web pages.',
        'Aldi products are sourced from cached retailer web observations.'
      ),
    };
  }

  public async findStores(_filters: StoreSearchFilters): Promise<Result<never[]>> {
    return {
      ok: false,
      error: {
        code: SourceWarningCode.RealSourceNotImplemented,
        message:
          'Aldi live-beta adapter covers product search only; store lookup is not implemented.',
      },
    };
  }

  public async searchPromotions(_filters: PromotionSearchFilters): Promise<Result<never[]>> {
    return {
      ok: false,
      error: {
        code: SourceWarningCode.RealSourceNotImplemented,
        message:
          'Aldi live-beta adapter covers product search only; promotions are not implemented.',
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
    filters: StoreProductAvailabilityFilters
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
      const record = await this.cache.set(
        cacheKey,
        entries,
        cacheableProvenance(result.provenance),
        this.cacheTtlMs
      );
      return {
        ok: true,
        data: entries,
        provenance: liveProvenanceWithCacheExpiry(result.provenance, record.expiresAt),
        warnings: [],
      };
    } catch (error) {
      const warning = warningFromError(
        error,
        this.productSitemapUrl,
        'Aldi product sitemap fetch failed',
        'aldi',
        ALDI_PROVIDER
      );
      if (cached) {
        return {
          ok: true,
          data: cached.data,
          provenance: cached.provenance,
          warnings: [warning, staleCacheWarning(cached.provenance, 'aldi', ALDI_PROVIDER)],
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
      const record = await this.cache.set(
        cacheKey,
        product,
        cacheableProvenance(result.provenance),
        this.cacheTtlMs
      );
      return {
        ok: true,
        data: product,
        provenance: liveProvenanceWithCacheExpiry(result.provenance, record.expiresAt),
        warnings: [],
      };
    } catch (error) {
      const warning = warningFromError(error, sourceUrl, 'Aldi product page fetch failed', 'aldi', ALDI_PROVIDER);
      if (cached) {
        return {
          ok: true,
          data: cached.data,
          provenance: cached.provenance,
          warnings: [warning, staleCacheWarning(cached.provenance, 'aldi', ALDI_PROVIDER)],
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
