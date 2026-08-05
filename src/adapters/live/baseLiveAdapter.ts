import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { SourceClientError, SourceHttpClient } from '../../sources/sourceClient.js';
import { calculateMatchStrength, normalize, sortProducts } from '../../util/matcher.js';
import {
  Chain,
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
} from '../types.js';

export interface LoadSuccess<T> {
  ok: true;
  data: T;
  provenance: SourceProvenance;
  warnings: SourceWarning[];
}

export interface LoadFailure {
  ok: false;
  error: {
    code: SourceWarningCode;
    message: string;
  };
  warnings: SourceWarning[];
}

export type LoadResult<T> = LoadSuccess<T> | LoadFailure;

export interface BaseLiveAdapterOptions {
  cache: FileTtlCache;
  sourceClient?: SourceHttpClient;
  rateLimitPerHostMs?: number;
}

export function cacheableProvenance(
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

export function liveProvenanceWithCacheExpiry(
  provenance: SourceProvenance,
  cacheExpiresAt: string
): SourceProvenance {
  return { ...provenance, cacheExpiresAt };
}

export function warningFromError(
  error: unknown,
  sourceUrl: string,
  messagePrefix: string,
  chain: Chain,
  provider: string
): SourceWarning {
  if (error instanceof SourceClientError) {
    return {
      chain,
      provider,
      sourceUrl: error.sourceUrl,
      code: error.code,
      message: `${messagePrefix}: ${error.message}`,
      observedAt: new Date().toISOString(),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    chain,
    provider,
    sourceUrl,
    code: SourceWarningCode.SourceParseFailed,
    message: `${messagePrefix}: ${message}`,
    observedAt: new Date().toISOString(),
  };
}

export function staleCacheWarning(
  provenance: SourceProvenance,
  chain: Chain,
  provider: string
): SourceWarning {
  return {
    chain,
    provider,
    sourceUrl: provenance.sourceUrl,
    code: SourceWarningCode.SourceStaleCacheUsed,
    message: `Using stale cached ${provider} source data because the live source is unavailable.`,
    observedAt: new Date().toISOString(),
  };
}

export function metadataFrom(
  provenances: SourceProvenance[],
  warnings: SourceWarning[],
  chain: Chain,
  provider: string,
  liveSummary: string,
  cachedSummary: string
): ResultMetadata {
  const primaryProvenance =
    provenances.find((p) => p.freshness === 'live') ?? provenances.at(0);
  const sources: SourceStatus[] = [
    {
      chain,
      status: primaryProvenance?.freshness === 'live' ? 'live-beta' : 'degraded',
      provider,
      sourceType: 'retailer-web',
      lastObservedAt: primaryProvenance?.observedAt,
      warning: warnings.at(0),
    },
  ];

  return {
    ...(warnings.length > 0 ? { sourceWarnings: warnings } : {}),
    sources,
    summary:
      primaryProvenance?.freshness === 'live' ? liveSummary : cachedSummary,
  };
}

/**
 * Opt-in tally of what this filter throws away, per chain.
 *
 * "Vendor search is bad" and "our matcher discards good vendor results" look
 * identical from outside — both end as a thin result list. They want opposite
 * responses, and we already know the distinction is not academic: for
 * "Milchdrink UHT" Migros returned twelve correct products and this predicate
 * rejected all twelve, because `uht` was missing from the modifier table.
 *
 * Off by default and never read in production; it exists so the question can
 * be measured instead of argued.
 */
export const matchDiagnostics = {
  enabled: false,
  byChain: new Map<string, { seen: number; rejectedRelevance: number; rejectedPrice: number }>(),
  reset(): void {
    this.byChain.clear();
  },
  record(chain: string, field: 'seen' | 'rejectedRelevance' | 'rejectedPrice'): void {
    if (!this.enabled) return;
    let row = this.byChain.get(chain);
    if (!row) {
      row = { seen: 0, rejectedRelevance: 0, rejectedPrice: 0 };
      this.byChain.set(chain, row);
    }
    row[field] += 1;
  },
};

export function productMatches(
  product: NormalizedProduct,
  query: string,
  filters: ProductSearchFilters
): boolean {
  const matchMode = filters.matchMode ?? 'balanced';
  matchDiagnostics.record(product.chain, 'seen');
  if (calculateMatchStrength(product, query, matchMode) === 0) {
    matchDiagnostics.record(product.chain, 'rejectedRelevance');
    return false;
  }

  if (product.price.current <= 0) {
    matchDiagnostics.record(product.chain, 'rejectedPrice');
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

export function notImplementedError(
  feature: string,
  chain: Chain
): { ok: false; error: { code: SourceWarningCode; message: string } } {
  return {
    ok: false,
    error: {
      code: SourceWarningCode.RealSourceNotImplemented,
      message: `${chain} adapter does not implement ${feature}.`,
    },
  };
}

export function notImplementedAvailability(
  chain: Chain,
  reason: string
): StoreAvailabilitySupport {
  return { chain, supported: false, reason };
}

export function notImplementedLookupResult(
  chain: Chain,
  filters: StoreProductAvailabilityFilters,
  reason: string
): Promise<Result<StoreProductAvailabilityResult>> {
  return Promise.resolve({
    ok: true,
    data: {
      chain,
      storeId: filters.storeId,
      query: filters.query,
      supported: false,
      reason,
      matches: [],
      isAvailable: false,
    },
  });
}

export async function loadJson<T>(
  url: string,
  cachePrefix: string,
  cache: FileTtlCache,
  sourceClient: SourceHttpClient,
  cacheTtlMs: number,
  chain: Chain,
  provider: string
): Promise<LoadResult<T>> {
  const cacheKey = `${cachePrefix}:${url}`;
  const cached = await cache.get<T>(cacheKey, { allowStale: true });
  if (cached && !cached.isStale) {
    return { ok: true, data: cached.data, provenance: cached.provenance, warnings: [] };
  }

  try {
    const result = await sourceClient.fetchJson<T>(url, {
      provider,
      chain,
      sourceType: 'retailer-web',
      confidence: 'medium',
    });
    const record = await cache.set(
      cacheKey,
      result.data,
      cacheableProvenance(result.provenance),
      cacheTtlMs
    );
    return {
      ok: true,
      data: result.data as T,
      provenance: liveProvenanceWithCacheExpiry(result.provenance, record.expiresAt),
      warnings: [],
    };
  } catch (error) {
    const warning = warningFromError(error, url, `${provider} API fetch failed`, chain, provider);
    if (cached) {
      return {
        ok: true,
        data: cached.data,
        provenance: cached.provenance,
        warnings: [warning, staleCacheWarning(cached.provenance, chain, provider)],
      };
    }

    return {
      ok: false,
      error: { code: warning.code, message: warning.message },
      warnings: [warning],
    };
  }
}

export async function loadText(
  url: string,
  cachePrefix: string,
  cache: FileTtlCache,
  sourceClient: SourceHttpClient,
  cacheTtlMs: number,
  chain: Chain,
  provider: string
): Promise<LoadResult<string>> {
  const cacheKey = `${cachePrefix}:${url}`;
  const cached = await cache.get<string>(cacheKey, { allowStale: true });
  if (cached && !cached.isStale) {
    return { ok: true, data: cached.data, provenance: cached.provenance, warnings: [] };
  }

  try {
    const result = await sourceClient.fetchText(url, {
      provider,
      chain,
      sourceType: 'retailer-web',
      confidence: 'medium',
    });
    const record = await cache.set(
      cacheKey,
      result.data,
      cacheableProvenance(result.provenance),
      cacheTtlMs
    );
    return {
      ok: true,
      data: result.data,
      provenance: liveProvenanceWithCacheExpiry(result.provenance, record.expiresAt),
      warnings: [],
    };
  } catch (error) {
    const warning = warningFromError(error, url, `${provider} source fetch failed`, chain, provider);
    if (cached) {
      return {
        ok: true,
        data: cached.data,
        provenance: cached.provenance,
        warnings: [warning, staleCacheWarning(cached.provenance, chain, provider)],
      };
    }

    return {
      ok: false,
      error: { code: warning.code, message: warning.message },
      warnings: [warning],
    };
  }
}

export function searchProductsFromLoaded<T>(
  parsed: T[],
  toNormalized: (item: T, provenance: SourceProvenance) => NormalizedProduct,
  provenance: SourceProvenance,
  warnings: SourceWarning[],
  filters: ProductSearchFilters,
  query: string,
  defaultLimit: number
): Result<NormalizedProduct[]> {
  const matchMode = filters.matchMode ?? 'balanced';
  const products = parsed
    .map((p) => toNormalized(p, provenance))
    .filter((product) => productMatches(product, query, filters))
    .sort((a, b) => sortProducts(a, b, query, matchMode));

  const limitedProducts =
    typeof filters.limit === 'number' ? products.slice(0, filters.limit) : products.slice(0, defaultLimit);

  return {
    ok: true,
    data: limitedProducts,
    metadata: metadataFrom([provenance], warnings, provenance.chain!, provenance.provider, '', ''),
  };
}
