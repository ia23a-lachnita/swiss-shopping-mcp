import { describe, expect, it } from 'vitest';

import { createDefaultAdapters } from '../adapters/index.js';
import {
  Chain,
  ChainAdapter,
  NormalizedProduct,
  NormalizedStore,
  ProductSearchFilters,
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
    stores?: NormalizedStore[];
    errorCode?: string;
    metadata?: ResultMetadata;
  },
): ChainAdapter {
  return {
    chain,
    async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
      if (behavior.errorCode) {
        return { ok: false, error: { code: behavior.errorCode, message: `${chain} failed.` } };
      }
      return { ok: true, data: (behavior.products ?? []).slice(0, filters.limit), metadata: behavior.metadata };
    },
    async findStores(filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
      if (behavior.errorCode) {
        return { ok: false, error: { code: behavior.errorCode, message: `${chain} failed.` } };
      }
      return { ok: true, data: (behavior.stores ?? []).slice(0, filters.limit), metadata: behavior.metadata };
    },
    getStoreAvailabilitySupport(): StoreAvailabilitySupport {
      return { chain, supported: false };
    },
    async lookupStoreProductAvailability(
      filters: StoreProductAvailabilityFilters,
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

describe('SearchService', () => {
  const service = new SearchService(createDefaultAdapters({ dataMode: 'legacy-static' }));

  it('searches across chains and returns price-sorted products', async () => {
    const result = await service.searchProducts({ query: 'pantry' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.length).toBeGreaterThanOrEqual(5);
      expect(result.data[0].chain).toBe('ottos');
      expect(result.data[1].chain).toBe('lidl');
    }
  });

  it('supports chain-restricted product search', async () => {
    const result = await service.searchProducts({
      query: 'milk',
      chains: ['migros'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].chain).toBe('migros');
    }
  });

  it('uses balanced matching by default for generic product families', async () => {
    const result = await service.searchProducts({ query: 'pasta' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((product) => product.id)).toEqual([
        'migros-pasta-500g',
        'ottos-pasta-500g',
        'denner-pasta-500g',
      ]);
    }
  });

  it('can preserve literal product matching when requested', async () => {
    const result = await service.searchProducts({ query: 'pasta', matchMode: 'literal' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((product) => product.id)).toEqual(['migros-pasta-500g']);
    }
  });

  it('returns an explicit error when query is empty', async () => {
    const result = await service.searchProducts({ query: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_QUERY');
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

  it('finds stores across matching chains', async () => {
    const result = await service.findStores({ location: 'zürich' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((store) => store.chain)).toEqual(['farmy', 'migros']);
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
    const result = await service.findStores({ location: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_LOCATION');
    }
  });

  it('lists store availability support across chains', () => {
    const result = service.getStoreAvailabilitySupport(['migros', 'coop']);
    expect(result).toEqual([
      { chain: 'coop', supported: false, reason: expect.any(String) },
      { chain: 'migros', supported: true },
    ]);
  });

  it('looks up product availability for a specific store', async () => {
    const result = await service.lookupStoreProductAvailability('migros', {
      storeId: 'migros-zurich-1',
      query: 'milk',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.supported).toBe(true);
      expect(result.data.isAvailable).toBe(true);
    }
  });

  it('returns unsupported availability metadata for chains without stock support', async () => {
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

  it('returns explicit error for missing store in availability lookup', async () => {
    const result = await service.lookupStoreProductAvailability('migros', {
      storeId: 'missing-store',
      query: 'milk',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STORE_NOT_FOUND');
    }
  });
});
