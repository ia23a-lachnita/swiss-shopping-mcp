import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { CoopLiveAdapter } from './coopLiveAdapter.js';
import { SourceWarningCode } from '../types.js';

vi.mock('../../util/geo.js', () => ({
  resolveLocationAsync: vi.fn().mockResolvedValue({ latitude: 47.3769, longitude: 8.5417 }),
}));

vi.mock('../../sources/sourceClient.js', () => {
  const mockFetchJson = vi.fn();
  return {
    SourceHttpClient: vi.fn().mockImplementation(() => ({
      fetchJson: mockFetchJson,
      fetchText: vi.fn(),
    })),
    SourceClientError: class SourceClientError extends Error {
      code: string;
      sourceUrl: string;
      status?: number;
      constructor(code: string, message: string, sourceUrl: string, status?: number) {
        super(message);
        this.code = code;
        this.sourceUrl = sourceUrl;
        this.status = status;
      }
    },
    __mocks: { mockFetchJson },
  };
});

function createMockCache() {
  return {
    get: vi.fn(),
    set: vi.fn(),
  } as unknown as FileTtlCache;
}

const mockSearchResponse = {
  products: [
    {
      code: 'coop-001',
      name: 'Coop Naturaplan Milch',
      brandName: 'Naturaplan',
      price: { value: 1.60, currencyIso: 'CHF' },
      primaryCategory: { name: 'Milchprodukte' },
      images: [{ url: 'https://example.com/coop-milk.jpg' }],
    },
    {
      code: 'coop-002',
      name: 'Coop Vollkornbrot',
      brandName: 'Coop',
      price: { value: 3.20, currencyIso: 'CHF' },
      primaryCategory: { name: 'Brot' },
    },
  ],
  total: 2,
};

const mockStoresResponse = {
  locations: [
    {
      vstId: 'coop-store-1',
      name: 'Coop Zürich Bahnhofstrasse',
      address: { town: 'Zürich', postalCode: '8001', line1: 'Bahnhofstrasse 10' },
      geoPoint: { latitude: 47.3769, longitude: 8.5417 },
      currentOpeningHours: 'Mo-Fr 08:00-20:00',
    },
    {
      vstId: 'coop-store-2',
      name: 'Coop Bern',
      address: { town: 'Bern', postalCode: '3011', line1: 'Spitalgasse 3' },
      geoPoint: { latitude: 46.9480, longitude: 7.4474 },
      currentOpeningHours: 'Mo-Sa 08:00-18:00',
    },
  ],
  total: 2,
};

const mockProvenance = {
  provider: 'Coop',
  chain: 'coop' as const,
  sourceType: 'retailer-web' as const,
  sourceUrl: 'https://www.coop.ch/rest/v2/coopathome/products/search/Milch?currentPage=0&pageSize=10&fields=FULL',
  observedAt: '2026-06-16T10:00:00.000Z',
  freshness: 'live' as const,
  confidence: 'medium' as const,
};

const mockCacheRecord = {
  expiresAt: '2026-06-16T16:00:00.000Z',
};

const mockStaleCacheHit = {
  data: mockSearchResponse,
  provenance: { ...mockProvenance, freshness: 'stale' as const, cacheExpiresAt: '2026-06-16T04:00:00.000Z' },
  observedAt: '2026-06-16T00:00:00.000Z',
  expiresAt: '2026-06-16T04:00:00.000Z',
  isStale: true,
};

describe('CoopLiveAdapter', () => {
  let cache: ReturnType<typeof createMockCache>;
  let adapter: CoopLiveAdapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mocks: any;

  beforeEach(async () => {
    cache = createMockCache();
    adapter = new CoopLiveAdapter({ cache });

    const sourceClientModule = await import('../../sources/sourceClient.js');
    mocks = (sourceClientModule as unknown as { __mocks: { mockFetchJson: ReturnType<typeof vi.fn> } }).__mocks;
    mocks.mockFetchJson.mockReset();
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
      mocks.mockFetchJson.mockResolvedValue({
        data: mockSearchResponse,
        provenance: mockProvenance,
      });
      cache.set.mockResolvedValue(mockCacheRecord);

      const result = await adapter.searchProducts({ query: 'Milch' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBeGreaterThan(0);
        expect(result.data[0]).toMatchObject({
          chain: 'coop',
          name: 'Coop Naturaplan Milch',
          price: { current: 1.60 },
        });
      }
      expect(mocks.mockFetchJson).toHaveBeenCalled();
    });

    it('returns error when fetch fails and no cache', async () => {
      cache.get.mockResolvedValue(undefined);
      mocks.mockFetchJson.mockRejectedValue(
        new Error('HTTP 503: Service Unavailable')
      );

      const result = await adapter.searchProducts({ query: 'Milch' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(SourceWarningCode.SourceParseFailed);
      }
    });

    it('falls back to stale cache on fetch failure', async () => {
      cache.get.mockResolvedValue(mockStaleCacheHit);
      mocks.mockFetchJson.mockRejectedValue(
        new Error('HTTP 503: Service Unavailable')
      );

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
      mocks.mockFetchJson.mockResolvedValue({
        data: mockStoresResponse,
        provenance: { ...mockProvenance, sourceUrl: 'https://www.coop.ch/rest/v2/coopathome/locations/searchAroundCoordinates?latitude=47.3769&longitude=8.5417&radius=5000' },
      });
      cache.set.mockResolvedValue(mockCacheRecord);

      const result = await adapter.findStores({ location: 'Zürich' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBe(2);
        expect(result.data[0]).toMatchObject({
          chain: 'coop',
          name: 'Coop Zürich Bahnhofstrasse',
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
        chain: 'coop',
        supported: true,
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
        expect(result.data.chain).toBe('coop');
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

describe('CoopLiveAdapter.getProductsByIds', () => {
  async function setup() {
    const sourceClientModule = await import('../../sources/sourceClient.js');
    const mocks = (sourceClientModule as unknown as { __mocks: { mockFetchJson: ReturnType<typeof vi.fn> } }).__mocks;
    mocks.mockFetchJson.mockReset();
    const cache = createMockCache() as FileTtlCache & {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
    };
    cache.get = vi.fn().mockResolvedValue(undefined);
    cache.set = vi.fn().mockResolvedValue({ expiresAt: '2099-01-01T00:00:00.000Z' });
    const adapter = new CoopLiveAdapter({ cache });
    return { adapter, mocks, cache };
  }

  it('hydrates a product from the detail endpoint including ingredients', async () => {
    const { adapter, mocks } = await setup();
    mocks.mockFetchJson.mockResolvedValue({
      data: {
        code: '4940251',
        name: 'Elmex Sensitive Professional',
        brandName: 'Elmex',
        price: { value: 5.95, currencyIso: 'CHF' },
        primaryCategory: { name: 'Zahnpaste' },
        images: [{ url: 'https://example.com/elmex.jpg' }],
        url: '/de/x/p/4940251',
        ingredients: '<p>Aqua, Hydrated Silica</p>',
      },
      provenance: {},
    });

    const result = await adapter.getProductsByIds(['4940251']);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        id: '4940251',
        chain: 'coop',
        name: 'Elmex Sensitive Professional',
        price: { current: 5.95 },
      });
      expect(result.data[0].ingredients?.[0]).toBe('Aqua, Hydrated Silica');
    }
    expect(mocks.mockFetchJson).toHaveBeenCalledWith(
      expect.stringContaining('/products/4940251?fields=FULL'),
      expect.anything()
    );
  });

  it('skips failed codes but returns the rest with a warning', async () => {
    const { adapter, mocks } = await setup();
    mocks.mockFetchJson.mockImplementation(async (url: string) => {
      if (url.includes('/products/111')) {
        throw new Error('HTTP 404');
      }
      return {
        data: {
          code: '222',
          name: 'Working Product',
          price: { value: 2.5, currencyIso: 'CHF' },
        },
        provenance: {},
      };
    });

    const result = await adapter.getProductsByIds(['111', '222']);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((p) => p.id)).toEqual(['222']);
      expect(result.metadata?.sourceWarnings?.length).toBe(1);
    }
  });

  it('fails with an error when every code fails', async () => {
    const { adapter, mocks } = await setup();
    mocks.mockFetchJson.mockRejectedValue(new Error('HTTP 500'));

    const result = await adapter.getProductsByIds(['111']);

    expect(result.ok).toBe(false);
  });

  it('ignores non-numeric IDs', async () => {
    const { adapter, mocks } = await setup();

    const result = await adapter.getProductsByIds(['abc']);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([]);
    }
    expect(mocks.mockFetchJson).not.toHaveBeenCalled();
  });
});
