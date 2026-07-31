import { describe, expect, it, vi } from 'vitest';

import { FileTtlCache } from '../cache/fileTtlCache.js';
import { UnsupportedChainAdapter } from '../adapters/unsupportedAdapter.js';
import {
  Chain,
  ChainAdapter,
  NormalizedProduct,
  NormalizedPromotion,
  NormalizedStore,
  ProductSearchFilters,
  PromotionSearchFilters,
  Result,
  ResultMetadata,
  SourceWarningCode,
  StoreAvailabilitySupport,
  StoreProductAvailabilityFilters,
  StoreProductAvailabilityResult,
  StoreSearchFilters,
} from '../adapters/types.js';
import { SearchService } from './searchService.js';
import { WebProductSearchService } from './webProductSearchService.js';

function stubAdapter(
  chain: Chain,
  behavior: {
    products?: NormalizedProduct[];
    promotions?: NormalizedPromotion[];
    stores?: NormalizedStore[];
    errorCode?: string;
    metadata?: ResultMetadata;
  }
): ChainAdapter {
  return {
    chain,
    async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
      if (behavior.errorCode) {
        return { ok: false, error: { code: behavior.errorCode, message: `${chain} failed.` } };
      }
      return {
        ok: true,
        data: (behavior.products ?? []).slice(0, filters.limit),
        metadata: behavior.metadata,
      };
    },
    async searchPromotions(
      filters: PromotionSearchFilters
    ): Promise<Result<NormalizedPromotion[]>> {
      if (behavior.errorCode) {
        return { ok: false, error: { code: behavior.errorCode, message: `${chain} failed.` } };
      }
      return {
        ok: true,
        data: (behavior.promotions ?? []).slice(0, filters.limit),
        metadata: behavior.metadata,
      };
    },
    async findStores(filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
      if (behavior.errorCode) {
        return { ok: false, error: { code: behavior.errorCode, message: `${chain} failed.` } };
      }
      return {
        ok: true,
        data: (behavior.stores ?? []).slice(0, filters.limit),
        metadata: behavior.metadata,
      };
    },
    getStoreAvailabilitySupport(): StoreAvailabilitySupport {
      return { chain, supported: false };
    },
    async lookupStoreProductAvailability(
      filters: StoreProductAvailabilityFilters
    ): Promise<Result<StoreProductAvailabilityResult>> {
      return {
        ok: true,
        data: {
          chain,
          storeId: filters.storeId,
          query: filters.query,
          supported: false,
          matches: [],
          isAvailable: false,
        },
      };
    },
  };
}

function testProduct(id: string, chain: Chain): NormalizedProduct {
  return {
    id,
    chain,
    name: id,
    price: { current: 1 },
  };
}

function testStore(id: string, chain: Chain): NormalizedStore {
  return {
    id,
    chain,
    name: id,
    address: 'Teststrasse 1, 8000 Zürich',
    location: { latitude: 47.3769, longitude: 8.5417 },
  };
}

function testPromotion(id: string, chain: Chain, current: number): NormalizedPromotion {
  return {
    id,
    chain,
    title: id,
    productName: id,
    price: { current },
    validFrom: new Date('2026-05-19T00:00:00.000Z'),
    validUntil: new Date('2026-05-20T23:59:59.999Z'),
  };
}

describe('SearchService', () => {
  it('returns an explicit error when query is empty', async () => {
    const service = new SearchService([stubAdapter('aldi', {})]);
    const result = await service.searchProducts({ query: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_QUERY');
    }
  });

  it('returns products from a source-backed adapter', async () => {
    const service = new SearchService([
      stubAdapter('aldi', { products: [testProduct('aldi-bread', 'aldi')] }),
    ]);

    const result = await service.searchProducts({ query: 'bread' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('aldi-bread');
    }
  });

  it('reports onChainProgress once per adapter, with a monotonically increasing respondedCount', async () => {
    const service = new SearchService([
      stubAdapter('aldi', { products: [testProduct('aldi-bread', 'aldi')] }),
      stubAdapter('coop', { products: [testProduct('coop-bread', 'coop')] }),
    ]);

    const events: Array<{ chain: Chain; ok: boolean; respondedCount: number; totalCount: number }> = [];
    const result = await service.searchProducts(
      { query: 'bread', chains: ['aldi', 'coop'] },
      { onChainProgress: (event) => events.push(event) }
    );

    expect(result.ok).toBe(true);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.chain))).toEqual(new Set(['aldi', 'coop']));
    expect(events.every((e) => e.totalCount === 2)).toBe(true);
    expect(events.every((e) => e.ok === true)).toBe(true);
    expect(events.map((e) => e.respondedCount).sort()).toEqual([1, 2]);
  });

  it('never reports a productsSoFar higher than the limit the response will apply', async () => {
    // Reported: the live counter climbed to 27 while the final list held 12,
    // because productsSoFar summed each chain's pre-limit result count.
    const service = new SearchService([
      stubAdapter('aldi', {
        products: [
          testProduct('aldi-1', 'aldi'),
          testProduct('aldi-2', 'aldi'),
          testProduct('aldi-3', 'aldi'),
        ],
      }),
      stubAdapter('coop', {
        products: [
          testProduct('coop-1', 'coop'),
          testProduct('coop-2', 'coop'),
          testProduct('coop-3', 'coop'),
        ],
      }),
    ]);

    const counts: number[] = [];
    const result = await service.searchProducts(
      { query: 'bread', chains: ['aldi', 'coop'], limit: 2 },
      { onChainProgress: (event) => counts.push(event.productsSoFar) }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Every streamed count is a promise the final list must be able to keep.
    expect(Math.max(...counts)).toBeLessThanOrEqual(result.data.length);
    expect(counts.every((n) => n <= 2)).toBe(true);
    // …and it still only ever counts upward.
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
  });

  it('reports an unclamped productsSoFar when the caller sets no limit', async () => {
    const service = new SearchService([
      stubAdapter('aldi', {
        products: [testProduct('aldi-1', 'aldi'), testProduct('aldi-2', 'aldi')],
      }),
    ]);

    const counts: number[] = [];
    await service.searchProducts(
      { query: 'bread', chains: ['aldi'] },
      { onChainProgress: (event) => counts.push(event.productsSoFar) }
    );

    expect(counts).toEqual([2]);
  });

  it('reports onChainProgress with ok:false for a failing chain, without failing the overall search', async () => {
    const service = new SearchService([
      stubAdapter('aldi', { products: [testProduct('aldi-bread', 'aldi')] }),
      stubAdapter('coop', { errorCode: 'SOURCE_UNAVAILABLE' }),
    ]);

    const events: Array<{ chain: Chain; ok: boolean }> = [];
    const result = await service.searchProducts(
      { query: 'bread', chains: ['aldi', 'coop'] },
      { onChainProgress: (event) => events.push(event) }
    );

    expect(result.ok).toBe(true);
    const coopEvent = events.find((e) => e.chain === 'coop');
    expect(coopEvent?.ok).toBe(false);
  });

  it('returns successful products with source warnings when one chain fails', async () => {
    const partialService = new SearchService([
      stubAdapter('migros', { products: [testProduct('milk', 'migros')] }),
      stubAdapter('coop', { errorCode: 'HTTP_503' }),
    ]);

    const result = await partialService.searchProducts({ query: 'milk' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((product) => product.id)).toEqual(['milk']);
      expect(result.metadata?.sourceWarnings).toEqual([
        expect.objectContaining({
          chain: 'coop',
          code: 'SOURCE_UNAVAILABLE',
          message: 'coop failed.',
        }),
      ]);
    }
  });

  it('does not let a hanging adapter block fast adapters past the per-adapter deadline', async () => {
    vi.useFakeTimers();
    try {
      const fastAdapter = stubAdapter('coop', { products: [testProduct('milk', 'coop')] });
      const hangingAdapter: ChainAdapter = {
        ...stubAdapter('migros', {}),
        // Simulates a genuinely hung adapter call (e.g. cold-start Playwright/VPN path) — never resolves.
        searchProducts: () => new Promise<Result<NormalizedProduct[]>>(() => {}),
      };
      const service = new SearchService([fastAdapter, hangingAdapter]);

      const resultPromise = service.searchProducts({ query: 'milk', chains: ['coop', 'migros'] });
      await vi.advanceTimersByTimeAsync(6_000);
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.map((product) => product.chain)).toEqual(['coop']);
        expect(result.metadata?.sourceWarnings).toEqual([
          expect.objectContaining({
            chain: 'migros',
            message: expect.stringContaining('did not respond within 6000ms'),
          }),
        ]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces REAL_SOURCE_NOT_IMPLEMENTED warning when UnsupportedChainAdapter is requested alongside a live adapter', async () => {
    const service = new SearchService([
      stubAdapter('aldi', { products: [testProduct('aldi-bread', 'aldi')] }),
      new UnsupportedChainAdapter('coop', {
        productSearch: 'No approved Coop product source is implemented.',
      }),
    ]);

    const result = await service.searchProducts({ query: 'bread', chains: ['aldi', 'coop'] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.metadata?.sourceWarnings).toEqual([
        expect.objectContaining({
          chain: 'coop',
          code: SourceWarningCode.RealSourceNotImplemented,
        }),
      ]);
    }
  });

  it('returns ALL_SOURCES_FAILED when only unsupported chains are requested', async () => {
    const service = new SearchService([
      new UnsupportedChainAdapter('coop', {
        productSearch: 'No approved Coop product source is implemented.',
      }),
    ]);

    const result = await service.searchProducts({ query: 'bread', chains: ['coop'] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([]);
      expect(result.metadata?.sourceWarnings).toBeDefined();
      expect(result.metadata?.sourceWarnings!.some((w) => w.chain === 'coop')).toBe(true);
    }
  });

  it('propagates metadata from successful product adapters', async () => {
    const sourceWarning = {
      chain: 'aldi' as const,
      code: SourceWarningCode.SourceStaleCacheUsed,
      message: 'Using stale cache.',
      observedAt: '2026-05-18T10:00:00.000Z',
    };
    const metadataService = new SearchService([
      stubAdapter('aldi', {
        products: [testProduct('aldi-bread', 'aldi')],
        metadata: {
          sourceWarnings: [sourceWarning],
          sources: [
            {
              chain: 'aldi',
              status: 'degraded',
              provider: 'ALDI SUISSE',
              sourceType: 'retailer-web',
              lastObservedAt: '2026-05-18T10:00:00.000Z',
            },
          ],
          summary: 'Aldi cache used.',
        },
      }),
    ]);

    const result = await metadataService.searchProducts({ query: 'bread' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metadata?.sourceWarnings).toEqual([sourceWarning]);
      expect(result.metadata?.sources?.[0]).toMatchObject({ chain: 'aldi', status: 'degraded' });
      expect(result.metadata?.summary).toBe('Aldi cache used.');
    }
  });

  it('returns an all-sources error when every searched chain fails', async () => {
    const failingService = new SearchService([
      stubAdapter('migros', { errorCode: 'HTTP_503' }),
      stubAdapter('coop', { errorCode: 'HTTP_429' }),
    ]);

    const result = await failingService.searchProducts({ query: 'milk' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([]);
      expect(result.metadata?.sourceWarnings).toBeDefined();
      expect(result.metadata?.sourceWarnings!.length).toBe(2);
    }
  });

  it('searches promotions across requested chains and sorts by current price', async () => {
    const promotionService = new SearchService([
      stubAdapter('denner', { promotions: [testPromotion('denner-orange', 'denner', 2)] }),
      stubAdapter('coop', { promotions: [testPromotion('coop-orange', 'coop', 3)] }),
    ]);

    const result = await promotionService.searchPromotions({ query: 'orange' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((promotion) => promotion.id)).toEqual([
        'denner-orange',
        'coop-orange',
      ]);
    }
  });

  it('keeps promotion relevance ahead of price when merging adapter results', async () => {
    const promotionService = new SearchService([
      stubAdapter('denner', { promotions: [testPromotion('orange', 'denner', 1)] }),
      stubAdapter('coop', { promotions: [testPromotion('orange-juice', 'coop', 3)] }),
    ]);

    const result = await promotionService.searchPromotions({ query: 'orange juice' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((promotion) => promotion.id)).toEqual(['orange-juice', 'orange']);
    }
  });

  it('returns successful stores with source warnings when one chain fails', async () => {
    const partialService = new SearchService([
      stubAdapter('migros', { stores: [testStore('migros-zurich', 'migros')] }),
      stubAdapter('coop', { errorCode: 'HTTP_429' }),
    ]);

    const result = await partialService.findStores({ location: 'zürich' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((store) => store.id)).toEqual(['migros-zurich']);
      expect(result.metadata?.sourceWarnings).toEqual([
        expect.objectContaining({
          chain: 'coop',
          code: 'SOURCE_RATE_LIMITED',
          message: 'coop failed.',
        }),
      ]);
    }
  });

  it('returns an all-sources error when every store lookup source fails', async () => {
    const failingService = new SearchService([
      stubAdapter('migros', { errorCode: 'HTTP_503' }),
      stubAdapter('coop', { errorCode: 'HTTP_429' }),
    ]);

    const result = await failingService.findStores({ location: 'zürich' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([]);
      expect(result.metadata?.sourceWarnings).toBeDefined();
      expect(result.metadata?.sourceWarnings!.length).toBe(2);
    }
  });

  it('returns an explicit error when store location is empty', async () => {
    const service = new SearchService([stubAdapter('aldi', {})]);
    const result = await service.findStores({ location: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_LOCATION');
    }
  });

  it('lists store availability support as unsupported for UnsupportedChainAdapter', () => {
    const service = new SearchService([
      new UnsupportedChainAdapter('migros'),
      new UnsupportedChainAdapter('coop'),
    ]);

    const result = service.getStoreAvailabilitySupport(['migros', 'coop']);
    expect(result).toEqual([
      { chain: 'coop', supported: false, reason: expect.any(String) },
      { chain: 'migros', supported: false, reason: expect.any(String) },
    ]);
  });

  it('returns unsupported availability metadata for chains without stock support', async () => {
    const service = new SearchService([new UnsupportedChainAdapter('coop')]);

    const result = await service.lookupStoreProductAvailability('coop', {
      storeId: 'coop-basel-1',
      query: 'milk',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.supported).toBe(false);
      expect(result.data.reason).toBeTruthy();
    }
  });
});

describe('SearchService web-augmented search', () => {
  function webService(
    adapters: ChainAdapter[],
    urlsBySite: Record<string, string[]>,
    options: { failSearch?: boolean } = {}
  ): WebProductSearchService {
    const provider = {
      name: 'ddg' as const,
      search: vi.fn(async (_query: string, opts: { site: string }) => {
        if (options.failSearch) throw new Error('engine down');
        return (urlsBySite[opts.site] ?? []).map((url, rank) => ({ url, rank }));
      }),
    };
    const cache = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue({ expiresAt: '2099-01-01T00:00:00.000Z' }),
    } as unknown as FileTtlCache;
    return new WebProductSearchService({ provider, adapters, cache });
  }

  function migrosAdapterWithHydration(
    vendorProducts: NormalizedProduct[],
    hydratedById: Record<string, NormalizedProduct>
  ): ChainAdapter {
    return {
      ...stubAdapter('migros', { products: vendorProducts }),
      async getProductsByIds(ids: string[]): Promise<Result<NormalizedProduct[]>> {
        return { ok: true, data: ids.map((id) => hydratedById[id]).filter(Boolean) };
      },
    };
  }

  it('ranks web-discovered products first and keeps enriched vendor copies on duplicates', async () => {
    const vendorCopy: NormalizedProduct = {
      ...testProduct('1001', 'migros'),
      nutrition: { energyKcal: 250 },
    };
    const vendorOnly = testProduct('2002', 'migros');
    const webOnly = testProduct('1003', 'migros');

    const adapter = migrosAdapterWithHydration([vendorCopy, vendorOnly], {
      '1001': testProduct('1001', 'migros'),
      '1003': webOnly,
    });
    const service = new SearchService([adapter], {
      webProductSearch: webService([adapter], {
        'migros.ch/de/product': [
          'https://www.migros.ch/de/product/1001',
          'https://www.migros.ch/de/product/1003',
        ],
      }),
    });

    const result = await service.searchProducts({ query: 'zahnpasta' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((p) => p.id)).toEqual(['1001', '1003', '2002']);
      // Duplicate keeps the vendor copy (enrichment) at the web-ranked position
      expect(result.data[0].nutrition?.energyKcal).toBe(250);
      expect(result.data[0].matchExplanation?.matchedBy).toEqual(['provider-rank']);
      expect(result.metadata?.summary).toContain('semantic web search');
    }
  });

  it('does not let a hanging web-search provider block the overall search past its soft deadline', async () => {
    vi.useFakeTimers();
    try {
      const vendorProduct = testProduct('2002', 'migros');
      const adapter = migrosAdapterWithHydration([vendorProduct], {});
      const hangingProvider = {
        name: 'ddg' as const,
        // Simulates a hung/rate-limited search provider (e.g. DDG under load) — never resolves.
        search: vi.fn(() => new Promise<Array<{ url: string; rank: number }>>(() => {})),
      };
      const cache = {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue({ expiresAt: '2099-01-01T00:00:00.000Z' }),
      } as unknown as FileTtlCache;
      const service = new SearchService([adapter], {
        webProductSearch: new WebProductSearchService({ provider: hangingProvider, adapters: [adapter], cache }),
      });

      const resultPromise = service.searchProducts({ query: 'zahnpasta' });
      await vi.advanceTimersByTimeAsync(8_000);
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.map((p) => p.id)).toEqual(['2002']);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to vendor-only results with a warning when the web search fails', async () => {
    const vendorProduct = testProduct('2002', 'migros');
    const adapter = migrosAdapterWithHydration([vendorProduct], {});
    const service = new SearchService([adapter], {
      webProductSearch: webService([adapter], {}, { failSearch: true }),
    });

    const result = await service.searchProducts({ query: 'zahnpasta' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((p) => p.id)).toEqual(['2002']);
      const webWarning = result.metadata?.sourceWarnings?.find((w) => w.provider === 'WebSearch');
      expect(webWarning?.message).toContain('engine down');
    }
  });

  it('returns web-discovered products even when every vendor search fails', async () => {
    const webOnly = testProduct('1003', 'migros');
    const adapter: ChainAdapter = {
      ...stubAdapter('migros', { errorCode: SourceWarningCode.SourceUnavailable }),
      async getProductsByIds(): Promise<Result<NormalizedProduct[]>> {
        return { ok: true, data: [webOnly] };
      },
    };
    const service = new SearchService([adapter], {
      webProductSearch: webService([adapter], {
        'migros.ch/de/product': ['https://www.migros.ch/de/product/1003'],
      }),
    });

    const result = await service.searchProducts({ query: 'zahnpasta' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((p) => p.id)).toEqual(['1003']);
      expect(result.metadata?.sourceWarnings?.length).toBeGreaterThan(0);
    }
  });

  it('interleaves web results across chains round-robin by rank', async () => {
    const migrosAdapter = migrosAdapterWithHydration([], {
      '1001': testProduct('1001', 'migros'),
      '1002': testProduct('1002', 'migros'),
    });
    const coopAdapter: ChainAdapter = {
      ...stubAdapter('coop', {}),
      async getProductsByIds(ids: string[]): Promise<Result<NormalizedProduct[]>> {
        return { ok: true, data: ids.map((id) => testProduct(id, 'coop')) };
      },
    };
    const adapters = [migrosAdapter, coopAdapter];
    const service = new SearchService(adapters, {
      webProductSearch: webService(adapters, {
        'migros.ch/de/product': [
          'https://www.migros.ch/de/product/1001',
          'https://www.migros.ch/de/product/1002',
        ],
        'coop.ch': ['https://www.coop.ch/de/x/p/3001'],
      }),
    });

    const result = await service.searchProducts({ query: 'zahnpasta', chains: ['migros', 'coop'] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((p) => `${p.chain}:${p.id}`)).toEqual([
        'migros:1001',
        'coop:3001',
        'migros:1002',
      ]);
    }
  });

  it('orders stores nearest-first for lookupAvailabilityByLocationProductsFirst', async () => {
    const farStore: NormalizedStore = {
      id: 'far',
      chain: 'migros',
      name: 'Migros Far',
      address: 'Weit weg',
      location: { latitude: 47.55, longitude: 8.9 },
    };
    const nearStore: NormalizedStore = {
      id: 'near',
      chain: 'migros',
      name: 'Migros Near',
      address: 'Ganz nah',
      location: { latitude: 47.377, longitude: 8.542 },
    };
    const service = new SearchService([
      stubAdapter('migros', {
        products: [testProduct('p1', 'migros')],
        // Intentionally returned far-then-near to prove sorting, not pass-through.
        stores: [farStore, nearStore],
      }),
    ]);

    const result = await service.lookupAvailabilityByLocationProductsFirst({
      query: 'p1',
      location: '8001 Zürich',
      chains: ['migros'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0].stores.map((s) => s.id)).toEqual(['near', 'far']);
    }
  });

  it('uses explicit latitude/longitude instead of geocoding location, when provided', async () => {
    const zurichStore: NormalizedStore = {
      id: 'zurich',
      chain: 'migros',
      name: 'Migros Zürich',
      address: 'Zürich HB',
      location: { latitude: 47.378, longitude: 8.54 },
    };
    const genevaStore: NormalizedStore = {
      id: 'geneva',
      chain: 'migros',
      name: 'Migros Genève',
      address: 'Gare de Genève',
      location: { latitude: 46.21, longitude: 6.14 },
    };
    const service = new SearchService([
      stubAdapter('migros', {
        products: [testProduct('p1', 'migros')],
        stores: [zurichStore, genevaStore],
      }),
    ]);

    // location text says Zürich (which geocodes near zurichStore), but the
    // explicit GPS coords point near Geneva instead - they must win, proving
    // raw device position isn't discarded once a display string exists.
    const result = await service.lookupAvailabilityByLocationProductsFirst({
      query: 'p1',
      location: '8001 Zürich',
      chains: ['migros'],
      latitude: 46.21,
      longitude: 6.14,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0].stores.map((s) => s.id)).toEqual(['geneva', 'zurich']);
    }
  });

  it('checks availability per product rather than sharing one chain-wide result', async () => {
    const store: NormalizedStore = testStore('store-1', 'migros');
    const lookupCalls: StoreProductAvailabilityFilters[] = [];
    const adapter: ChainAdapter = {
      ...stubAdapter('migros', {
        products: [testProduct('p1', 'migros'), testProduct('p2', 'migros')],
        stores: [store],
      }),
      async lookupStoreProductAvailability(
        filters: StoreProductAvailabilityFilters
      ): Promise<Result<StoreProductAvailabilityResult>> {
        lookupCalls.push(filters);
        // Availability differs per product: only p1 is in stock.
        const isP1 = filters.product?.id === 'p1';
        return {
          ok: true,
          data: {
            chain: 'migros',
            storeId: filters.storeId,
            query: filters.query,
            supported: true,
            matches: [{ product: filters.product ?? testProduct('unknown', 'migros'), available: isP1, storeId: filters.storeId }],
            isAvailable: isP1,
          },
        };
      },
    };
    const service = new SearchService([adapter]);

    const result = await service.lookupAvailabilityByLocationProductsFirst({
      query: 'milch',
      location: '8001 Zürich',
      chains: ['migros'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const byId = new Map(result.data.map((r) => [r.product.id, r]));
      expect(byId.get('p1')?.stores[0]?.available).toBe(true);
      expect(byId.get('p2')?.stores[0]?.available).toBe(false);
    }
    // Every adapter call must carry the specific product being checked.
    expect(lookupCalls.every((c) => c.product !== undefined)).toBe(true);
    expect(lookupCalls.map((c) => c.product?.id).sort()).toEqual(['p1', 'p2']);
  });
});
