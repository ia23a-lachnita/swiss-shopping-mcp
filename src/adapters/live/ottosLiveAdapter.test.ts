import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { SourceHttpClient, SourceClientError } from '../../sources/sourceClient.js';
import { OttosLiveAdapter } from './ottosLiveAdapter.js';
import { SourceWarningCode } from '../types.js';

function createMockCache() {
  return {
    get: vi.fn(),
    set: vi.fn(),
  } as unknown as FileTtlCache;
}

function createMockSourceClient() {
  return {
    fetchJson: vi.fn(),
    fetchText: vi.fn(),
  } as unknown as SourceHttpClient;
}

const SEARCH_API_URL = 'https://www.ottos.ch/de/search';
const STORES_API_URL = 'https://www.ottos.ch/de/store-finder';

const mockSearchResponse = [
  {
    id: 'ottos-001',
    name: "Otto's Erdnussmus",
    brand: "Otto's",
    price: { amount: 2.90, currency: 'CHF' },
    category: 'Nüsse',
    image_url: 'https://example.com/ottos-peanut.jpg',
  },
  {
    id: 'ottos-002',
    name: "Otto's Haferflocken",
    brand: "Otto's",
    price: { amount: 1.80, currency: 'CHF' },
    category: 'Getreide',
  },
];

const mockStoresResponse = [
  {
    id: 'ottos-store-1',
    name: "Otto's Zürich",
    city: 'Zürich',
    zip: '8002',
    street: 'Badenerstrasse',
    street_number: '500',
    latitude: 47.3912,
    longitude: 8.5230,
    opening_hours: 'Mo-Fr 09:00-19:00',
  },
  {
    id: 'ottos-store-2',
    name: "Otto's Winterthur",
    city: 'Winterthur',
    zip: '8400',
    street: 'Technikumstrasse',
    street_number: '10',
    latitude: 47.4984,
    longitude: 8.7291,
    opening_hours: 'Mo-Sa 09:00-18:00',
  },
];

const mockProvenance = {
  provider: "Otto's",
  chain: 'ottos' as const,
  sourceType: 'retailer-web' as const,
  sourceUrl: SEARCH_API_URL,
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

describe("OttosLiveAdapter", () => {
  let cache: ReturnType<typeof createMockCache>;
  let sourceClient: ReturnType<typeof createMockSourceClient>;
  let adapter: OttosLiveAdapter;

  beforeEach(() => {
    cache = createMockCache();
    sourceClient = createMockSourceClient();
    adapter = new OttosLiveAdapter({
      cache,
      sourceClient,
      searchApiUrl: SEARCH_API_URL,
      storesApiUrl: STORES_API_URL,
    });
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
      sourceClient.fetchJson.mockResolvedValue({
        data: mockSearchResponse,
        provenance: mockProvenance,
      });
      cache.set.mockResolvedValue(mockCacheRecord);

      const result = await adapter.searchProducts({ query: 'Erdnussmus' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBeGreaterThan(0);
        expect(result.data[0]).toMatchObject({
          chain: 'ottos',
          name: "Otto's Erdnussmus",
          price: { current: 2.90 },
        });
      }
      expect(sourceClient.fetchJson).toHaveBeenCalled();
    });

    it('returns error when fetch fails and no cache', async () => {
      cache.get.mockResolvedValue(undefined);
      sourceClient.fetchJson.mockRejectedValue(
        new SourceClientError(SourceWarningCode.SourceUnavailable, 'HTTP 503: Service Unavailable', SEARCH_API_URL, 503)
      );

      const result = await adapter.searchProducts({ query: 'Erdnussmus' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(SourceWarningCode.SourceUnavailable);
      }
    });

    it('falls back to stale cache on fetch failure', async () => {
      cache.get.mockResolvedValue(mockStaleCacheHit);
      sourceClient.fetchJson.mockRejectedValue(
        new SourceClientError(SourceWarningCode.SourceUnavailable, 'HTTP 503: Service Unavailable', SEARCH_API_URL, 503)
      );

      const result = await adapter.searchProducts({ query: 'Erdnussmus' });

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
      sourceClient.fetchJson.mockResolvedValue({
        data: mockStoresResponse,
        provenance: { ...mockProvenance, sourceUrl: STORES_API_URL },
      });
      cache.set.mockResolvedValue(mockCacheRecord);

      const result = await adapter.findStores({ location: 'Zürich' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBe(2);
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
        query: 'Erdnussmus',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.supported).toBe(false);
        expect(result.data.isAvailable).toBe(false);
      }
    });
  });
});
