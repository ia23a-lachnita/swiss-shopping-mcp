import { describe, expect, it, vi } from 'vitest';

import { CacheHit, FileTtlCache } from '../cache/fileTtlCache.js';
import { SourceCircuitBreaker } from '../services/sourceCircuitBreaker.js';
import {
  CompositeWebSearchProvider,
  DuckDuckGoHtmlProvider,
  GoogleCustomSearchProvider,
  TypedWebSearchError,
  WebSearchProvider,
  WebSearchResult,
} from './webSearch.js';
import {
  Chain,
  ChainAdapter,
  NormalizedProduct,
  Result,
} from '../adapters/types.js';
import { WebProductSearchService } from '../services/webProductSearchService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeClock(initial: Date): { now(): Date; advanceMs(ms: number): void } {
  let current = initial.getTime();
  return {
    now: (): Date => new Date(current),
    advanceMs: (ms: number): void => { current += ms; },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html' },
  });
}

function mockProvider(
  name: 'google' | 'ddg',
  results: WebSearchResult[],
  options: { failWith?: Error } = {},
): WebSearchProvider & { search: ReturnType<typeof vi.fn> } {
  return {
    name,
    search: vi.fn(async () => {
      if (options.failWith) throw options.failWith;
      return results;
    }),
  } as unknown as WebSearchProvider & { search: ReturnType<typeof vi.fn> };
}

function stubAdapter(
  chain: Chain,
  products: NormalizedProduct[],
): ChainAdapter & { getProductsByIds: ReturnType<typeof vi.fn> } {
  return {
    chain,
    searchProducts: vi.fn(async () => ({ ok: true, data: products }) as Result<NormalizedProduct[]>),
    searchPromotions: vi.fn(),
    findStores: vi.fn(),
    getStoreAvailabilitySupport: vi.fn(),
    lookupStoreProductAvailability: vi.fn(),
    getProductsByIds: vi.fn(async (ids: string[]): Promise<Result<NormalizedProduct[]>> => {
      return { ok: true, data: ids.map((id) => products.find((p) => p.id === id)).filter(Boolean) as NormalizedProduct[] };
    }),
  } as unknown as ChainAdapter & { getProductsByIds: ReturnType<typeof vi.fn> };
}

function product(id: string, chain: Chain, price = 2.5): NormalizedProduct {
  return { id, chain, name: `Product ${id}`, price: { current: price } };
}

function freshCacheHit<T>(data: T): CacheHit<T> {
  return {
    data,
    provenance: { provider: 'Test', sourceType: 'third-party' as const, freshness: 'cached' as const, confidence: 'medium' as const, observedAt: '2026-01-01T00:00:00.000Z' },
    observedAt: '2026-01-01T00:00:00.000Z',
    refreshAfter: '2099-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    staleUntil: '2099-01-01T00:00:00.000Z',
    fresh: true,
    needsRefresh: false,
    staleFallback: undefined,
    isStale: false,
  };
}

function createMockCache(): FileTtlCache & { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue({ expiresAt: '2099-01-01T00:00:00.000Z' }),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as FileTtlCache & { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
}


// ---------------------------------------------------------------------------
// Deliverable 1: TypedWebSearchError classification
// ---------------------------------------------------------------------------

describe('TypedWebSearchError', () => {
  it('classifies 401/403 as non-retryable', () => {
    const err = new TypedWebSearchError({
      message: 'bad key',
      provider: 'google',
      retryable: false,
      httpStatus: 401,
    });
    expect(err.retryable).toBe(false);
    expect(err.httpStatus).toBe(401);
    expect(err.provider).toBe('google');
  });

  it('classifies 429 as retryable', () => {
    const err = new TypedWebSearchError({
      message: 'rate limited',
      provider: 'google',
      retryable: true,
      httpStatus: 429,
    });
    expect(err.retryable).toBe(true);
  });

  it('classifies 5xx as retryable', () => {
    const err = new TypedWebSearchError({
      message: 'server error',
      provider: 'ddg',
      retryable: true,
      httpStatus: 503,
    });
    expect(err.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deliverable 1: Google 429 → DDG fallback
// ---------------------------------------------------------------------------

describe('CompositeWebSearchProvider failover', () => {
  it('falls back to DDG when Google throws a retryable 429 error', async () => {
    const googleResults: WebSearchResult[] = [];
    const google = mockProvider('google', googleResults, {
      failWith: new TypedWebSearchError({
        message: 'rate limited',
        provider: 'google',
        retryable: true,
        httpStatus: 429,
      }),
    });
    const ddgResults: WebSearchResult[] = [
      { url: 'https://www.migros.ch/de/product/514160800000', rank: 0 },
    ];
    const ddg = mockProvider('ddg', ddgResults);
    const breaker = new SourceCircuitBreaker({ failureThreshold: 5, cooldownMs: 60_000 });

    const provider = new CompositeWebSearchProvider({ primary: google, fallback: ddg, breaker });
    const results = await provider.search('milch', { site: 'migros.ch' });

    expect(google.search).toHaveBeenCalledOnce();
    expect(ddg.search).toHaveBeenCalledOnce();
    expect(results).toEqual(ddgResults);
  });

  it('surfaces non-retryable errors (invalid credentials) without fallback', async () => {
    const google = mockProvider('google', [], {
      failWith: new TypedWebSearchError({
        message: 'bad key',
        provider: 'google',
        retryable: false,
        httpStatus: 401,
      }),
    });
    const ddg = mockProvider('ddg', [{ url: 'https://www.migros.ch/de/product/514160800000', rank: 0 }]);
    const breaker = new SourceCircuitBreaker({ failureThreshold: 5, cooldownMs: 60_000 });

    const provider = new CompositeWebSearchProvider({ primary: google, fallback: ddg, breaker });

    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toThrow(TypedWebSearchError);
    // DDG should NOT be called
    expect(ddg.search).not.toHaveBeenCalled();
  });

  it('returns empty array when all providers are skipped by breaker', async () => {
    const google = mockProvider('google', [{ url: 'https://migros.ch/product/1', rank: 0 }]);
    const ddg = mockProvider('ddg', [{ url: 'https://migros.ch/product/2', rank: 0 }]);
    const breaker = new SourceCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });

    // Open both breakers
    breaker.recordFailure('google');
    breaker.recordFailure('ddg');

    const provider = new CompositeWebSearchProvider({ primary: google, fallback: ddg, breaker });
    const results = await provider.search('milch', { site: 'migros.ch' });

    expect(results).toEqual([]);
    expect(google.search).not.toHaveBeenCalled();
    expect(ddg.search).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Deliverable 2: Circuit breaker integration
// ---------------------------------------------------------------------------

describe('Circuit breaker integration', () => {
  it('opens Google breaker after repeated retryable failures', async () => {
    const clock = fakeClock(new Date('2026-06-15T10:00:00.000Z'));
    const google = mockProvider('google', [], {
      failWith: new TypedWebSearchError({
        message: '429',
        provider: 'google',
        retryable: true,
        httpStatus: 429,
      }),
    });
    const ddg = mockProvider('ddg', [{ url: 'https://migros.ch/product/1', rank: 0 }]);
    const breaker = new SourceCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000, clock });

    const provider = new CompositeWebSearchProvider({ primary: google, fallback: ddg, breaker, clock });

    // First 3 calls: Google fails, DDG succeeds
    for (let i = 0; i < 3; i++) {
      await provider.search('milch', { site: 'migros.ch' });
    }

    // After 3 failures, Google breaker should be open
    expect(breaker.isOpen('google')).toBe(true);

    // Next call: Google should be skipped entirely
    google.search.mockClear();
    ddg.search.mockClear();
    await provider.search('milch', { site: 'migros.ch' });
    expect(google.search).not.toHaveBeenCalled();
    expect(ddg.search).toHaveBeenCalledOnce();

    // After cooldown, Google should be tried again (half-open recovery)
    clock.advanceMs(60_001);
    google.search.mockClear();
    google.search.mockResolvedValueOnce([{ url: 'https://migros.ch/product/1', rank: 0 }]);
    await provider.search('milch', { site: 'migros.ch' });
    expect(google.search).toHaveBeenCalledOnce();
    expect(breaker.isOpen('google')).toBe(false);
  });

  it('opens DDG breaker on repeated failures, falls back to stale cache / vendor only', async () => {
    const clock = fakeClock(new Date('2026-06-15T10:00:00.000Z'));
    const google = mockProvider('google', [], {
      failWith: new TypedWebSearchError({
        message: 'no google keys',
        provider: 'google',
        retryable: false,
        httpStatus: 401,
      }),
    });
    const ddg = mockProvider('ddg', [], {
      failWith: new TypedWebSearchError({
        message: 'DDG 202',
        provider: 'ddg',
        retryable: true,
        httpStatus: 202,
      }),
    });
    const breaker = new SourceCircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000, clock });

    const provider = new CompositeWebSearchProvider({
      primary: google,
      fallback: ddg,
      breaker,
      clock,
    });

    // Google fails non-retryable → surfaced immediately
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toThrow('no google keys');

    // Remove Google to test DDG-only scenario
    const ddgOnly = new CompositeWebSearchProvider({
      fallback: ddg,
      breaker,
      clock,
    });

    // DDG fails twice → breaker opens
    await ddgOnly.search('milch', { site: 'migros.ch' }).catch(() => {});
    await ddgOnly.search('milch', { site: 'migros.ch' }).catch(() => {});
    expect(breaker.isOpen('ddg')).toBe(true);

    // Now DDG should be skipped
    ddg.search.mockClear();
    const results = await ddgOnly.search('milch', { site: 'migros.ch' });
    expect(ddg.search).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Deliverable 3: Budget (tested via providerBudget.test.ts)
// ---------------------------------------------------------------------------

describe('Budget integration in CompositeWebSearchProvider', () => {
  it('skips Google when budget is exhausted', async () => {
    const google = mockProvider('google', [{ url: 'https://migros.ch/product/1', rank: 0 }]);
    const ddg = mockProvider('ddg', [{ url: 'https://migros.ch/product/2', rank: 0 }]);
    const breaker = new SourceCircuitBreaker({ failureThreshold: 10, cooldownMs: 60_000 });

    // Create a mock budget that reports Google as exhausted
    const budget = {
      isExhausted: vi.fn((provider: string) => provider === 'google'),
      isLow: vi.fn(() => false),
      recordRequest: vi.fn(),
      recordFailure: vi.fn(),
      recordCacheHit: vi.fn(),
    };

    const provider = new CompositeWebSearchProvider({
      primary: google,
      fallback: ddg,
      breaker,
      budget: budget as never,
    });

    const results = await provider.search('milch', { site: 'migros.ch' });

    // Google should be skipped due to budget
    expect(google.search).not.toHaveBeenCalled();
    // DDG should be used as fallback
    expect(ddg.search).toHaveBeenCalledOnce();
    expect(results).toEqual([{ url: 'https://migros.ch/product/2', rank: 0 }]);
    expect(budget.isExhausted).toHaveBeenCalledWith('google');
  });

  it('skips Google when budget is low (<10%)', async () => {
    const google = mockProvider('google', [{ url: 'https://migros.ch/product/1', rank: 0 }]);
    const ddg = mockProvider('ddg', [{ url: 'https://migros.ch/product/2', rank: 0 }]);
    const breaker = new SourceCircuitBreaker({ failureThreshold: 10, cooldownMs: 60_000 });

    const budget = {
      isExhausted: vi.fn(() => false),
      isLow: vi.fn((provider: string) => provider === 'google'),
      recordRequest: vi.fn(),
      recordFailure: vi.fn(),
      recordCacheHit: vi.fn(),
    };

    const provider = new CompositeWebSearchProvider({
      primary: google,
      fallback: ddg,
      breaker,
      budget: budget as never,
    });

    const results = await provider.search('milch', { site: 'migros.ch' });

    expect(google.search).not.toHaveBeenCalled();
    expect(ddg.search).toHaveBeenCalledOnce();
    expect(results).toEqual([{ url: 'https://migros.ch/product/2', rank: 0 }]);
  });
});

// ---------------------------------------------------------------------------
// Deliverable 5: Aggregated multi-domain query
// ---------------------------------------------------------------------------

describe('CompositeWebSearchProvider.searchAggregated', () => {
  it('builds an OR site query for Google and groups results by site', async () => {
    const googleResults: WebSearchResult[] = [
      { url: 'https://www.migros.ch/de/product/514160800000', rank: 0 },
      { url: 'https://www.coop.ch/de/x/p/4940251', rank: 1 },
      { url: 'https://www.migros.ch/de/product/mo/106497', rank: 2 },
    ];
    const google = mockProvider('google', googleResults);
    const ddg = mockProvider('ddg', []);
    const breaker = new SourceCircuitBreaker({ failureThreshold: 10, cooldownMs: 60_000 });

    const provider = new CompositeWebSearchProvider({ primary: google, fallback: ddg, breaker });
    const results = await provider.searchAggregated('milch', [
      'migros.ch/de/product',
      'coop.ch',
    ]);

    // Google should be called with OR sites
    expect(google.search).toHaveBeenCalledOnce();
    const callOptions = google.search.mock.calls[0][1] as { site: string };
    expect(callOptions.site).toContain('migros.ch/de/product');
    expect(callOptions.site).toContain('coop.ch');
    expect(callOptions.site).toContain(' OR site:');

    expect(results).toHaveLength(3);
  });

  it('falls back to serial DDG queries when Google is skipped by budget', async () => {
    const google = mockProvider('google', [{ url: 'https://migros.ch/product/1', rank: 0 }]);
    const ddgResults1: WebSearchResult[] = [{ url: 'https://www.migros.ch/de/product/514160800000', rank: 0 }];
    const ddgResults2: WebSearchResult[] = [{ url: 'https://www.coop.ch/de/x/p/4940251', rank: 0 }];
    const ddg: WebSearchProvider & { search: ReturnType<typeof vi.fn> } = {
      name: 'ddg',
      search: vi.fn(async (_query: string, opts: { site: string }) => {
        if (opts.site === 'migros.ch/de/product') return ddgResults1;
        if (opts.site === 'coop.ch') return ddgResults2;
        return [];
      }),
    } as unknown as WebSearchProvider & { search: ReturnType<typeof vi.fn> };
    const breaker = new SourceCircuitBreaker({ failureThreshold: 10, cooldownMs: 60_000 });

    // Budget blocks Google
    const budget = {
      isExhausted: vi.fn((p: string) => p === 'google'),
      isLow: vi.fn(() => false),
      recordRequest: vi.fn(),
      recordFailure: vi.fn(),
      recordCacheHit: vi.fn(),
    };

    const provider = new CompositeWebSearchProvider({
      primary: google,
      fallback: ddg,
      breaker,
      budget: budget as never,
    });

    const results = await provider.searchAggregated('milch', [
      'migros.ch/de/product',
      'coop.ch',
    ]);

    // Google should NOT be called (budget exhausted)
    expect(google.search).not.toHaveBeenCalled();
    // DDG should be called twice (once per site)
    expect(ddg.search).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
  });

  it('handles single site by delegating to normal search', async () => {
    const google = mockProvider('google', [{ url: 'https://migros.ch/product/1', rank: 0 }]);
    const ddg = mockProvider('ddg', []);
    const breaker = new SourceCircuitBreaker({ failureThreshold: 10, cooldownMs: 60_000 });

    const provider = new CompositeWebSearchProvider({ primary: google, fallback: ddg, breaker });
    const results = await provider.searchAggregated('milch', ['migros.ch/de/product']);

    expect(google.search).toHaveBeenCalledOnce();
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Deliverable 4: Strong vendor results → skip web search
// ---------------------------------------------------------------------------

describe('SearchService vendor strength evaluation', () => {
  it('skips web search when vendor results are strong (>=8 results, >=80% with price)', async () => {
    const { SearchService } = await import('../services/searchService.js');

    const vendorProducts = Array.from({ length: 10 }, (_, i) => product(`p${i}`, 'migros'));
    const adapter = stubAdapter('migros', vendorProducts);

    const webProvider = mockProvider('ddg', [{ url: 'https://migros.ch/product/web1', rank: 0 }]);
    const cache = createMockCache();
    const webService = new WebProductSearchService({
      provider: webProvider,
      adapters: [adapter],
      cache,
    });

    const searchService = new SearchService([adapter], { webProductSearch: webService });
    await searchService.searchProducts({ query: 'milch' });

    // Web search should NOT have been called
    expect(webProvider.search).not.toHaveBeenCalled();
  });

  it('runs web search for weak retailers when some are strong but others are weak', async () => {
    const { SearchService } = await import('../services/searchService.js');

    // Migros has strong results, coop has none
    const migrosProducts = Array.from({ length: 10 }, (_, i) => product(`m${i}`, 'migros'));
    const migrosAdapter = stubAdapter('migros', migrosProducts);
    const coopAdapter = stubAdapter('coop', []);

    const webProvider = mockProvider('ddg', []);
    const cache = createMockCache();
    const webService = new WebProductSearchService({
      provider: webProvider,
      adapters: [migrosAdapter, coopAdapter],
      cache,
    });

    const searchService = new SearchService([migrosAdapter, coopAdapter], {
      webProductSearch: webService,
    });
    await searchService.searchProducts({ query: 'milch', chains: ['migros', 'coop'] });

    // Web search should have been called for coop (weak) but not migros (strong)
    expect(webProvider.search).toHaveBeenCalled();
    // Check that the search was only called for coop
    const searchCalls = webProvider.search.mock.calls;
    const siteCalled = searchCalls.map((call: unknown[]) => (call[1] as { site: string }).site);
    expect(siteCalled).toContain('coop.ch');
  });

  it('runs web search when overall vendor results are below threshold', async () => {
    const { SearchService } = await import('../services/searchService.js');

    const adapter = stubAdapter('migros', [product('p1', 'migros')]);

    const webProvider = mockProvider('ddg', [{ url: 'https://migros.ch/product/1', rank: 0 }]);
    const cache = createMockCache();
    const webService = new WebProductSearchService({
      provider: webProvider,
      adapters: [adapter],
      cache,
    });

    const searchService = new SearchService([adapter], { webProductSearch: webService });
    await searchService.searchProducts({ query: 'milch' });

    // Only 1 result (< 8 threshold), so web search should run
    expect(webProvider.search).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Deliverable 6: Hydration health → rediscovery
// ---------------------------------------------------------------------------

describe('Hydration health tracking', () => {
  it('invalidates discovery mapping when <50% of IDs hydrate successfully', async () => {
    const adapter = stubAdapter('migros', []);
    // getProductsByIds returns empty for all IDs (0% hydration success)
    adapter.getProductsByIds.mockResolvedValue({ ok: true, data: [] });

    const webProvider = mockProvider('ddg', [
      { url: 'https://www.migros.ch/de/product/514160800000', rank: 0 },
      { url: 'https://www.migros.ch/de/product/mo/106497', rank: 1 },
    ]);

    const cache = createMockCache();
    // Return a cached mapping (simulating stale data)
    cache.get.mockResolvedValue(freshCacheHit({ ids: ['514160800000', '106497'] }));

    const service = new WebProductSearchService({
      provider: webProvider,
      adapters: [adapter],
      cache,
    });

    // First call: uses cached IDs, but hydration fails (0% success)
    const result = await service.searchProducts({ query: 'milch' }, ['migros']);
    expect(result.productsByChain.size).toBe(0);

    // Cache should have been deleted (invalidated due to poor hydration)
    expect(cache.delete).toHaveBeenCalled();
  });

  it('does not force rediscovery again after a forced rediscovery (prevents loops)', async () => {
    const adapter = stubAdapter('migros', []);
    adapter.getProductsByIds.mockResolvedValue({ ok: true, data: [] });

    const webProvider = mockProvider('ddg', [
      { url: 'https://www.migros.ch/de/product/514160800000', rank: 0 },
    ]);

    const cache = createMockCache();
    cache.get.mockResolvedValue(freshCacheHit({ ids: ['514160800000'] }));

    const service = new WebProductSearchService({
      provider: webProvider,
      adapters: [adapter],
      cache,
    });

    // First call: triggers rediscovery
    await service.searchProducts({ query: 'milch' }, ['migros']);
    const deleteCount = cache.delete.mock.calls.length;

    // Second call: should NOT trigger another rediscovery
    await service.searchProducts({ query: 'milch' }, ['migros']);
    expect(cache.delete.mock.calls.length).toBe(deleteCount);
  });
});

// ---------------------------------------------------------------------------
// Existing Google 429 → typed error test (update to verify TypedWebSearchError)
// ---------------------------------------------------------------------------

describe('GoogleCustomSearchProvider typed errors', () => {
  it('throws TypedWebSearchError on 429 with retryable=true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: {} }, 429));
    const provider = new GoogleCustomSearchProvider({ apiKey: 'key', cx: 'cx', fetchImpl });

    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toThrow(TypedWebSearchError);
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: true,
      httpStatus: 429,
    });
  });

  it('throws TypedWebSearchError on 401 with retryable=false', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: {} }, 401));
    const provider = new GoogleCustomSearchProvider({ apiKey: 'key', cx: 'cx', fetchImpl });

    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: false,
      httpStatus: 401,
    });
  });

  it('throws TypedWebSearchError on 500 with retryable=true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: {} }, 500));
    const provider = new GoogleCustomSearchProvider({ apiKey: 'key', cx: 'cx', fetchImpl });

    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: true,
      httpStatus: 500,
    });
  });

  it('throws TypedWebSearchError on quota-exceeded body with retryable=true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { code: 429, message: 'Quota exceeded' } }, 200)
    );
    const provider = new GoogleCustomSearchProvider({ apiKey: 'key', cx: 'cx', fetchImpl });

    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: true,
    });
  });
});

describe('DuckDuckGoHtmlProvider typed errors', () => {
  it('throws TypedWebSearchError on 202 with retryable=true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse('challenge', 202));
    const provider = new DuckDuckGoHtmlProvider({ fetchImpl });

    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: true,
      httpStatus: 202,
    });
  });

  it('throws TypedWebSearchError on 403 with retryable=false', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse('blocked', 403));
    const provider = new DuckDuckGoHtmlProvider({ fetchImpl });

    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: false,
      httpStatus: 403,
    });
  });

  it('throws TypedWebSearchError on 500 with retryable=true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse('error', 500));
    const provider = new DuckDuckGoHtmlProvider({ fetchImpl });

    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: true,
      httpStatus: 500,
    });
  });
});
