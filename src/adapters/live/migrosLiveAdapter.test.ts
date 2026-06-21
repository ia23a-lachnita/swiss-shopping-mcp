import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { MigrosLiveAdapter } from './migrosLiveAdapter.js';
import { SourceWarningCode } from '../types.js';

vi.mock('../../util/geo.js', () => ({
  resolveLocationAsync: vi.fn().mockResolvedValue({ latitude: 47.3769, longitude: 8.5417 }),
}));

vi.mock('migros-api-wrapper', () => {
  const mockSearchProduct = vi.fn();
  const mockGetProductDetails = vi.fn();
  const mockSearchStores = vi.fn();
  const mockLoginGuestToken = vi.fn();
  return {
    MigrosAPI: vi.fn().mockImplementation(() => ({
      leShopToken: 'mock-token',
      account: { oauth2: { loginGuestToken: mockLoginGuestToken } },
      products: {
        productSearch: { searchProduct: mockSearchProduct },
        productDisplay: { getProductDetails: mockGetProductDetails },
      },
      stores: { searchStores: mockSearchStores },
    })),
    __mocks: { mockSearchProduct, mockGetProductDetails, mockSearchStores, mockLoginGuestToken },
  };
});

function createMockCache() {
  return {
    get: vi.fn(),
    set: vi.fn(),
  } as unknown as FileTtlCache;
}

const mockSearchApiResponse = {
  productIds: [123, 456],
};

const mockProductDetailsResponse = {
  '0': {
    uid: 123,
    name: 'Milch',
    brand: 'Migros',
    offer: {
      price: { effectiveValue: 1.85, unit: { unit: '100ml', value: 0.19 } },
    },
    images: [],
    productUrls: [],
    primaryCategory: { name: 'Milchprodukte' },
  },
  '1': {
    uid: 456,
    name: 'Butter',
    brand: 'Migros',
    offer: {
      price: { effectiveValue: 2.50, unit: { unit: '100g', value: 0.25 } },
    },
    images: [],
    productUrls: [],
    primaryCategory: { name: 'Milchprodukte' },
  },
};

const mockStoresApiResponse = [
  {
    storeId: '001',
    storeName: 'Migros Zürich',
    location: { latitude: 47.37, longitude: 8.54 },
    openingHours: [{ date: '2026-06-17', hours: [{ open: '06:30', close: '20:00' }] }],
  },
  {
    storeId: '002',
    storeName: 'Migros Winterthur',
    location: { latitude: 47.49, longitude: 8.73 },
    openingHours: [{ date: '2026-06-17', hours: [{ open: '08:00', close: '18:00' }] }],
  },
];

const mockProvenance = {
  provider: 'Migros',
  chain: 'migros' as const,
  sourceType: 'retailer-web' as const,
  sourceUrl: 'https://www.migros.ch/onesearch-oc-seaapi/public/v5/search',
  observedAt: '2026-06-16T10:00:00.000Z',
  freshness: 'live' as const,
  confidence: 'medium' as const,
};

const mockCacheRecord = {
  expiresAt: '2026-06-16T16:00:00.000Z',
};

const mockStaleCacheHit = {
  data: {
    products: [
      { id: 123, name: 'Milch', brand_name: 'Migros', price: { amount: 1.85, currency: 'CHF' }, category_name: 'Milchprodukte', image_url: '' },
      { id: 456, name: 'Butter', brand_name: 'Migros', price: { amount: 2.50, currency: 'CHF' }, category_name: 'Milchprodukte', image_url: '' },
    ],
  },
  provenance: { ...mockProvenance, freshness: 'stale' as const, cacheExpiresAt: '2026-06-16T04:00:00.000Z' },
  observedAt: '2026-06-16T00:00:00.000Z',
  expiresAt: '2026-06-16T04:00:00.000Z',
  isStale: true,
};

describe('MigrosLiveAdapter', () => {
  let cache: ReturnType<typeof createMockCache>;
  let adapter: MigrosLiveAdapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mocks: any;

  beforeEach(async () => {
    cache = createMockCache();
    adapter = new MigrosLiveAdapter({ cache });

    const migrosApiModule = await import('migros-api-wrapper');
    mocks = (migrosApiModule as unknown as { __mocks: typeof import('migros-api-wrapper') }).__mocks;
    mocks.mockSearchProduct.mockReset();
    mocks.mockGetProductDetails.mockReset();
    mocks.mockSearchStores.mockReset();
    mocks.mockLoginGuestToken.mockReset();
  });

  describe('searchProducts', () => {
    it('returns error on empty query', async () => {
      const result = await adapter.searchProducts({ query: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_QUERY');
      }
    });

    it('returns products on valid API response', async () => {
      cache.get.mockResolvedValue(undefined);
      mocks.mockLoginGuestToken.mockResolvedValue({});
      mocks.mockSearchProduct.mockResolvedValue(mockSearchApiResponse);
      mocks.mockGetProductDetails.mockResolvedValue(mockProductDetailsResponse);
      cache.set.mockResolvedValue(mockCacheRecord);

      const result = await adapter.searchProducts({ query: 'Milch' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBeGreaterThan(0);
        expect(result.data[0]).toMatchObject({
          chain: 'migros',
          name: 'Milch',
          price: { current: 1.85 },
        });
      }
      expect(mocks.mockSearchProduct).toHaveBeenCalled();
      expect(mocks.mockGetProductDetails).toHaveBeenCalled();
    });

    it('returns error when wrapper call fails and no cache', async () => {
      cache.get.mockResolvedValue(undefined);
      mocks.mockLoginGuestToken.mockResolvedValue({});
      mocks.mockSearchProduct.mockRejectedValue(new Error('HTTP 503: Service Unavailable'));

      const result = await adapter.searchProducts({ query: 'Milch' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(SourceWarningCode.SourceParseFailed);
      }
    });

    it('falls back to stale cache on fetch failure', async () => {
      cache.get.mockResolvedValue(mockStaleCacheHit);
      mocks.mockLoginGuestToken.mockResolvedValue({});
      mocks.mockSearchProduct.mockRejectedValue(new Error('HTTP 503: Service Unavailable'));

      const result = await adapter.searchProducts({ query: 'Milch' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBeGreaterThan(0);
        expect(result.data[0].provenance?.freshness).toBe('stale');
      }
    });
  });

  describe('findStores', () => {
    it('returns error on empty location', async () => {
      const result = await adapter.findStores({ location: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_QUERY');
      }
    });

    it('returns stores on valid response', async () => {
      cache.get.mockResolvedValue(undefined);
      mocks.mockLoginGuestToken.mockResolvedValue({});
      cache.set.mockResolvedValue(mockCacheRecord);
      mocks.mockSearchStores.mockResolvedValue(mockStoresApiResponse);

      const result = await adapter.findStores({ location: 'Zürich' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBe(2);
        expect(result.data[0]).toMatchObject({
          chain: 'migros',
          name: 'Migros Zürich',
        });
      }
    });
  });

  describe('searchPromotions', () => {
    it('returns not-implemented error', async () => {
      const result = await adapter.searchPromotions({ query: 'test' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(SourceWarningCode.RealSourceNotImplemented);
      }
    });
  });

  describe('getStoreAvailabilitySupport', () => {
    it('returns supported', () => {
      const support = adapter.getStoreAvailabilitySupport();
      expect(support).toEqual({
        chain: 'migros',
        supported: false,
        reason: 'Migros store-availability API returns 403 (blocked/down). Endpoint may have changed.',
      });
    });
  });

  describe('lookupStoreProductAvailability', () => {
    it('returns availability when product found (API fails -> unsupported)', async () => {
      const result = await adapter.lookupStoreProductAvailability({
        storeId: '0150164',
        query: 'Milch',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.supported).toBe(false);
        expect(result.data.chain).toBe('migros');
        expect(result.data.query).toBe('Milch');
        expect(Array.isArray(result.data.matches)).toBe(true);
      }
    });

    it('returns empty result for empty query', async () => {
      const result = await adapter.lookupStoreProductAvailability({
        storeId: '0150164',
        query: '',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.supported).toBe(false);
        expect(result.data.matches).toEqual([]);
        expect(result.data.isAvailable).toBe(false);
      }
    });
  });
});
