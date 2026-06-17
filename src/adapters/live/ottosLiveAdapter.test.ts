import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { SourceClientError } from '../../sources/sourceClient.js';
import { OttosLiveAdapter } from './ottosLiveAdapter.js';
import { SourceWarningCode } from '../types.js';

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

const { __mocks } = (await import('../../sources/sourceClient.js')) as unknown as {
  __mocks: { mockFetchJson: ReturnType<typeof vi.fn> };
};
const { mockFetchJson } = __mocks;

const SEARCH_URL = 'https://api.ottos.ch/occ/v2/ottos/products/search';
const STORES_URL = 'https://api.ottos.ch/occ/v2/ottos/stores';

const mockSearchResponse = {
  products: [
    {
      code: 'ottos-001',
      name: "Otto's Vollmilch",
      price: { formattedValue: 'CHF 1.50' },
      images: [{ url: 'https://example.com/ottos-milk.jpg' }],
      categories: [{ name: 'Milchprodukte' }],
    },
    {
      code: 'ottos-002',
      name: "Otto's Butter",
      price: { formattedValue: 'CHF 2.60' },
      images: [],
      categories: [{ name: 'Milchprodukte' }],
    },
  ],
};

const mockStoresResponse = {
  stores: [
    {
      name: "Otto's Zürich",
      address: { town: 'Zürich', postalCode: '8001', line1: 'Bahnhofstrasse 10' },
      geoPoint: { latitude: 47.3769, longitude: 8.5417 },
      openingHours: 'Mo-Fr 08:00-20:00',
    },
  ],
};

function createMockCache() {
  return {
    get: vi.fn(),
    set: vi.fn(),
  } as unknown as FileTtlCache & { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
}

function makeProvenance(sourceUrl: string, freshness: 'live' | 'stale' = 'live') {
  return {
    provider: "Otto's",
    chain: 'ottos' as const,
    sourceType: 'retailer-web' as const,
    sourceUrl,
    observedAt: '2026-06-17T10:00:00.000Z',
    freshness,
    confidence: 'medium' as const,
  };
}

function makeSourceError(sourceUrl: string) {
  return new SourceClientError(
    SourceWarningCode.SourceUnavailable,
    'HTTP 503: Service Unavailable',
    sourceUrl,
    503,
  );
}

describe('OttosLiveAdapter', () => {
  let cache: ReturnType<typeof createMockCache>;
  let adapter: OttosLiveAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    cache = createMockCache();
    adapter = new OttosLiveAdapter({ cache });
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
      mockFetchJson.mockResolvedValue({
        data: mockSearchResponse,
        provenance: makeProvenance(SEARCH_URL),
      });
      cache.set.mockResolvedValue({ expiresAt: '2026-06-17T16:00:00.000Z' });

      const result = await adapter.searchProducts({ query: 'Vollmilch' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBeGreaterThan(0);
        expect(result.data[0]).toMatchObject({
          chain: 'ottos',
          name: "Otto's Vollmilch",
        });
      }
      expect(mockFetchJson).toHaveBeenCalled();
    });

    it('returns error when fetch fails and no cache', async () => {
      cache.get.mockResolvedValue(undefined);
      mockFetchJson.mockRejectedValue(makeSourceError(SEARCH_URL));

      const result = await adapter.searchProducts({ query: 'Vollmilch' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(SourceWarningCode.SourceUnavailable);
      }
    });

    it('falls back to stale cache on fetch failure', async () => {
      cache.get.mockResolvedValue({
        data: mockSearchResponse,
        provenance: { ...makeProvenance(SEARCH_URL, 'stale'), cacheExpiresAt: '2026-06-17T04:00:00.000Z' },
        isStale: true,
      });
      mockFetchJson.mockRejectedValue(makeSourceError(SEARCH_URL));

      const result = await adapter.searchProducts({ query: 'Vollmilch' });

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
      mockFetchJson.mockResolvedValue({
        data: mockStoresResponse,
        provenance: makeProvenance(STORES_URL),
      });
      cache.set.mockResolvedValue({ expiresAt: '2026-06-17T16:00:00.000Z' });

      const result = await adapter.findStores({ location: 'Zürich' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBe(1);
        expect(result.data[0]).toMatchObject({
          chain: 'ottos',
          name: "Otto's Zürich",
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
    it('returns not supported', () => {
      const support = adapter.getStoreAvailabilitySupport();
      expect(support).toEqual({
        chain: 'ottos',
        supported: false,
        reason: "Otto's store-level product availability is not yet implemented.",
      });
    });
  });

  describe('lookupStoreProductAvailability', () => {
    it('returns not supported', async () => {
      const result = await adapter.lookupStoreProductAvailability({
        storeId: 'ottos-zurich',
        query: 'Vollmilch',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.supported).toBe(false);
        expect(result.data.isAvailable).toBe(false);
      }
    });
  });
});
