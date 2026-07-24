import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { MigrosLiveAdapter } from './migrosLiveAdapter.js';
import { SourceWarningCode } from '../types.js';

vi.mock('../../util/geo.js', () => ({
  resolveLocationAsync: vi.fn().mockResolvedValue({ latitude: 47.3769, longitude: 8.5417 }),
}));

vi.mock('./migrosBrowser.js', () => ({
  getGuestToken: vi.fn(),
  migrosFetch: vi.fn(),
  searchProducts: vi.fn(),
  fetchProductCards: vi.fn(),
  fetchProductCardsByMigrosIds: vi.fn(),
  fetchProductDetail: vi.fn(),
  searchStores: vi.fn(),
  checkAvailability: vi.fn(),
}));

function createMockCache() {
  return {
    get: vi.fn(),
    set: vi.fn(),
  } as unknown as FileTtlCache & { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
}

const mockSearchApiResponse = {
  items: [{ id: 123 }, { id: 456 }],
  numberOfProducts: 2,
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
  provenance: { provider: 'Migros', chain: 'migros' as const, sourceType: 'retailer-web' as const, sourceUrl: 'test', observedAt: '2026-06-16T10:00:00.000Z', freshness: 'stale' as const, confidence: 'medium' as const, cacheExpiresAt: '2026-06-16T04:00:00.000Z' },
  observedAt: '2026-06-16T00:00:00.000Z',
  expiresAt: '2026-06-16T04:00:00.000Z',
  isStale: true,
};

describe('MigrosLiveAdapter', () => {
  let cache: ReturnType<typeof createMockCache>;
  let adapter: MigrosLiveAdapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browserMocks: any;

  beforeEach(async () => {
    cache = createMockCache();
    adapter = new MigrosLiveAdapter({ cache });

    const browserModule = await import('./migrosBrowser.js');
    browserMocks = browserModule;
    browserMocks.getGuestToken.mockReset();
    browserMocks.migrosFetch.mockReset();
    browserMocks.searchProducts.mockReset();
    browserMocks.fetchProductCards.mockReset();
    browserMocks.fetchProductDetail.mockReset();
    browserMocks.searchStores.mockReset();
    browserMocks.checkAvailability.mockReset();
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
      browserMocks.getGuestToken.mockResolvedValue('mock-token');
      browserMocks.searchProducts.mockResolvedValue(mockSearchApiResponse);
      browserMocks.fetchProductCards.mockResolvedValue(mockProductDetailsResponse);
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
      expect(browserMocks.getGuestToken).toHaveBeenCalled();
      expect(browserMocks.searchProducts).toHaveBeenCalledTimes(1);
      expect(browserMocks.fetchProductCards).toHaveBeenCalledTimes(1);
    });

    it('returns error when search fails and no cache', async () => {
      cache.get.mockResolvedValue(undefined);
      browserMocks.getGuestToken.mockResolvedValue('mock-token');
      browserMocks.searchProducts.mockRejectedValue(new Error('HTTP 503: Service Unavailable'));

      const result = await adapter.searchProducts({ query: 'Milch' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(SourceWarningCode.SourceParseFailed);
      }
    });

    it('falls back to stale cache on fetch failure', async () => {
      cache.get.mockResolvedValue(mockStaleCacheHit);
      browserMocks.getGuestToken.mockResolvedValue('mock-token');
      browserMocks.searchProducts.mockRejectedValue(new Error('HTTP 503: Service Unavailable'));

      const result = await adapter.searchProducts({ query: 'Milch' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBeGreaterThan(0);
        expect(result.data[0].provenance?.freshness).toBe('stale');
      }
    });

    describe('nutrition enrichment', () => {
      function nutrientsDetail(headers: string[]): unknown {
        return {
          productInformation: {
            nutrientsInformation: {
              nutrientsTable: {
                headers,
                rows: [
                  { label: 'Energie', values: headers.map((_, i) => (i === headers.indexOf('100 ml') || i === headers.indexOf('100 g') ? '287 kJ (69 kcal)' : '710 kJ (170 kcal)')) },
                  { label: 'Eiweiss', values: headers.map((_, i) => (i === headers.indexOf('100 ml') || i === headers.indexOf('100 g') ? '3.2 g' : '8 g')) },
                  { label: 'Kohlenhydrate', values: headers.map((_, i) => (i === headers.indexOf('100 ml') || i === headers.indexOf('100 g') ? '5 g' : '12 g')) },
                  { label: 'Fett', values: headers.map((_, i) => (i === headers.indexOf('100 ml') || i === headers.indexOf('100 g') ? '4 g' : '10 g')) },
                  { label: 'Ballaststoffe', values: headers.map(() => '0 g') },
                  { label: 'davon Zucker', values: headers.map((_, i) => (i === headers.indexOf('100 ml') || i === headers.indexOf('100 g') ? '5 g' : '12 g')) },
                ],
              },
            },
          },
        };
      }

      it('extracts the per-100ml column when it is first', async () => {
        cache.get.mockResolvedValue(undefined);
        browserMocks.getGuestToken.mockResolvedValue('mock-token');
        browserMocks.searchProducts.mockResolvedValue(mockSearchApiResponse);
        browserMocks.fetchProductCards.mockResolvedValue(mockProductDetailsResponse);
        browserMocks.fetchProductDetail.mockResolvedValue(nutrientsDetail(['100 ml', '1 Glas (250 ml)']));
        cache.set.mockResolvedValue(mockCacheRecord);

        const result = await adapter.searchProducts({ query: 'Milch' });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data[0].nutrition).toMatchObject({
            energyKcal: 69,
            protein: 3.2,
            carbs: 5,
            fat: 4,
            sugar: 5,
          });
        }
      });

      it('locates the per-100g column even when a per-portion column comes first', async () => {
        // Real Migros responses have consistently led with the per-100 column
        // in samples checked, but the table has no documented ordering
        // guarantee - this proves the column is found by header, not by
        // assuming index 0, so a reordered table can't silently mislabel
        // per-portion values as per-100g/100ml.
        cache.get.mockResolvedValue(undefined);
        browserMocks.getGuestToken.mockResolvedValue('mock-token');
        browserMocks.searchProducts.mockResolvedValue(mockSearchApiResponse);
        browserMocks.fetchProductCards.mockResolvedValue(mockProductDetailsResponse);
        browserMocks.fetchProductDetail.mockResolvedValue(nutrientsDetail(['1 Glas (250 ml)', '100 ml']));
        cache.set.mockResolvedValue(mockCacheRecord);

        const result = await adapter.searchProducts({ query: 'Milch' });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data[0].nutrition).toMatchObject({
            energyKcal: 69,
            protein: 3.2,
            carbs: 5,
            fat: 4,
            sugar: 5,
          });
        }
      });

      it('omits nutrition rather than mislabeling per-portion data when no per-100 column exists', async () => {
        cache.get.mockResolvedValue(undefined);
        browserMocks.getGuestToken.mockResolvedValue('mock-token');
        browserMocks.searchProducts.mockResolvedValue(mockSearchApiResponse);
        browserMocks.fetchProductCards.mockResolvedValue(mockProductDetailsResponse);
        browserMocks.fetchProductDetail.mockResolvedValue(nutrientsDetail(['1 Portion (30 g)']));
        cache.set.mockResolvedValue(mockCacheRecord);

        const result = await adapter.searchProducts({ query: 'Milch' });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data[0].nutrition).toBeUndefined();
        }
      });
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
      browserMocks.getGuestToken.mockResolvedValue('mock-token');
      browserMocks.searchStores.mockResolvedValue(mockStoresApiResponse);
      cache.set.mockResolvedValue(mockCacheRecord);

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

  describe('getStoreAvailabilitySupport', () => {
    it('returns supported', () => {
      const support = adapter.getStoreAvailabilitySupport();
      expect(support).toEqual({
        chain: 'migros',
        supported: true,
      });
    });
  });

  describe('lookupStoreProductAvailability', () => {
    it('returns availability when product found', async () => {
      // searchProducts -> getGuestToken
      browserMocks.getGuestToken.mockResolvedValue('mock-token');
      // searchProducts -> searchProducts (browser)
      browserMocks.searchProducts.mockResolvedValue(mockSearchApiResponse);
      // searchProducts -> fetchProductCards
      browserMocks.fetchProductCards.mockResolvedValue(mockProductDetailsResponse);
      cache.set.mockResolvedValueOnce({ expiresAt: '2099-01-01T00:00:00.000Z' });
      // availability -> checkAvailability
      browserMocks.checkAvailability.mockResolvedValue({
        availabilities: [
          { id: '0150164', stock: 5 },
          { id: '0150165', stock: 0 },
        ],
        catalogItemId: 123,
      });

      const result = await adapter.lookupStoreProductAvailability({
        storeId: '0150164',
        query: 'Milch',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.supported).toBe(true);
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

  describe('searchPromotions', () => {
    const mockPromotionSearchResponse = {
      status: 200,
      data: {
        items: [{ id: 123, type: 'PRODUCT' }, { id: 456, type: 'PRODUCT' }],
        startDate: '2026-07-23',
        endDate: '2026-07-29',
      },
    };

    const mockPromotionCards = {
      '0': {
        uid: 123,
        name: 'Königssalat',
        brand: 'Migros',
        primaryCategory: { name: 'Salat' },
        offer: {
          price: { effectiveValue: 3.7 },
          promotionPrice: { effectiveValue: 3.2 },
          quantity: '150g',
          badges: [{ description: '14%' }],
        },
        images: [],
        productUrls: [],
      },
      '1': {
        uid: 456,
        name: 'Butter (regular price)',
        brand: 'Migros',
        offer: { price: { effectiveValue: 2.5 } },
        images: [],
        productUrls: [],
      },
    };

    it('returns error on empty query', async () => {
      const result = await adapter.searchPromotions({ query: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_QUERY');
      }
    });

    it('returns only discounted items matching the query', async () => {
      cache.get.mockResolvedValue(undefined);
      browserMocks.getGuestToken.mockResolvedValue('mock-token');
      browserMocks.migrosFetch.mockResolvedValue(mockPromotionSearchResponse);
      browserMocks.fetchProductCards.mockResolvedValue(mockPromotionCards);
      cache.set.mockResolvedValue(mockCacheRecord);

      const result = await adapter.searchPromotions({ query: 'salat' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0]).toMatchObject({
          chain: 'migros',
          title: 'Königssalat',
          originalPrice: 3.7,
          price: { current: 3.2 },
        });
        expect(result.data[0].validFrom).toBeInstanceOf(Date);
        expect(result.data[0].validUntil).toBeInstanceOf(Date);
      }
    });

    it('excludes non-discounted products even when they match the query text', async () => {
      cache.get.mockResolvedValue(undefined);
      browserMocks.getGuestToken.mockResolvedValue('mock-token');
      browserMocks.migrosFetch.mockResolvedValue(mockPromotionSearchResponse);
      browserMocks.fetchProductCards.mockResolvedValue(mockPromotionCards);
      cache.set.mockResolvedValue(mockCacheRecord);

      const result = await adapter.searchPromotions({ query: 'butter' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(0);
      }
    });

    it('falls back to stale cache when the live fetch fails', async () => {
      const staleProvenance = { provider: 'Migros', chain: 'migros' as const, sourceType: 'retailer-web' as const, sourceUrl: 'test', observedAt: '2026-07-20T00:00:00.000Z', freshness: 'stale' as const, confidence: 'medium' as const, cacheExpiresAt: '2026-07-20T06:00:00.000Z' };
      cache.get.mockResolvedValue({
        data: [{
          id: '123',
          sourceUrl: 'https://www.migros.ch/x',
          title: 'Königssalat',
          brand: 'Migros',
          category: 'Salat',
          price: { current: 3.2 },
          originalPrice: 3.7,
          discount: { type: 'percentage', value: 14 },
          description: '150g',
          validFrom: '2026-07-23',
          validUntil: '2026-07-29',
        }],
        provenance: staleProvenance,
        observedAt: '2026-07-20T00:00:00.000Z',
        expiresAt: '2026-07-20T06:00:00.000Z',
        isStale: true,
      });
      browserMocks.getGuestToken.mockResolvedValue('mock-token');
      browserMocks.migrosFetch.mockRejectedValue(new Error('HTTP 503: Service Unavailable'));

      const result = await adapter.searchPromotions({ query: 'salat' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].provenance?.freshness).toBe('stale');
      }
    });
  });
});

describe('MigrosLiveAdapter.getProductsByIds', () => {
  it('hydrates products preserving the input ID order and caches the result', async () => {
    const cache = createMockCache();
    const adapter = new MigrosLiveAdapter({ cache });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const browserMocks: any = await import('./migrosBrowser.js');
    browserMocks.getGuestToken.mockReset();
    browserMocks.fetchProductCardsByMigrosIds.mockReset();
    cache.get.mockResolvedValue(undefined);
    cache.set.mockResolvedValue(mockCacheRecord);
    browserMocks.getGuestToken.mockResolvedValue('mock-token');
    browserMocks.fetchProductCardsByMigrosIds.mockResolvedValue(mockProductDetailsResponse);

    const result = await adapter.getProductsByIds(['456', '123']);

    expect(browserMocks.fetchProductCardsByMigrosIds).toHaveBeenCalledWith(['456', '123'], 'mock-token');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((p) => p.id)).toEqual(['456', '123']);
      expect(result.data[0].name).toBe('Butter');
      expect(result.data[1].name).toBe('Milch');
    }
    expect(cache.set).toHaveBeenCalled();
  });

  it('returns empty data for non-numeric IDs without calling the API', async () => {
    const cache = createMockCache();
    const adapter = new MigrosLiveAdapter({ cache });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const browserMocks: any = await import('./migrosBrowser.js');
    browserMocks.fetchProductCardsByMigrosIds.mockReset();

    const result = await adapter.getProductsByIds(['abc', '']);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([]);
    }
    expect(browserMocks.fetchProductCardsByMigrosIds).not.toHaveBeenCalled();
  });

  it('serves hydrated products from cache without hitting the API', async () => {
    const cache = createMockCache();
    const adapter = new MigrosLiveAdapter({ cache });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const browserMocks: any = await import('./migrosBrowser.js');
    browserMocks.fetchProductCardsByMigrosIds.mockReset();
    cache.get.mockResolvedValue({
      data: { products: Object.values(mockProductDetailsResponse).map((raw) => ({
        id: (raw as { uid: number }).uid,
        name: (raw as { name: string }).name,
        brand_name: 'Migros',
        price: { amount: 1.85, currency: 'CHF' },
        category_name: 'Milchprodukte',
        image_url: '',
        url: '',
        quantity: '',
      })) },
      provenance: { provider: 'Migros', chain: 'migros', sourceType: 'retailer-web', sourceUrl: 'test', observedAt: '2026-06-16T10:00:00.000Z', freshness: 'cached', confidence: 'medium' },
      isStale: false,
    });

    const result = await adapter.getProductsByIds(['123']);

    expect(result.ok).toBe(true);
    expect(browserMocks.fetchProductCardsByMigrosIds).not.toHaveBeenCalled();
  });
});
