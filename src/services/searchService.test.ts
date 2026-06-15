import { describe, expect, it } from 'vitest';

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

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ALL_SOURCES_FAILED');
      expect(result.error.message).toContain('coop');
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

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ALL_SOURCES_FAILED');
      expect(result.error.message).toContain('migros');
      expect(result.error.message).toContain('coop');
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

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ALL_SOURCES_FAILED');
      expect(result.error.message).toContain('migros');
      expect(result.error.message).toContain('coop');
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
