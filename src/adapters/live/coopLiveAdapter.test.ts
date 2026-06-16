import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { SourceHttpClient, SourceClientError } from '../../sources/sourceClient.js';
import { CoopLiveAdapter } from './coopLiveAdapter.js';
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

const SEARCH_API_URL = 'https://www.coop.ch/de/search';
const STORES_API_URL = 'https://www.coop.ch/de/store-finder';

const mockSearchResponse = {
  products: [
    {
      id: 'coop-001',
      name: 'Coop Naturaplan Milch',
      brand: 'Naturaplan',
      price: { amount: 1.60, currency: 'CHF' },
      category: 'Milchprodukte',
      image_url: 'https://example.com/coop-milk.jpg',
    },
    {
      id: 'coop-002',
      name: 'Coop Vollkornbrot',
      brand: 'Coop',
      price: { amount: 3.20, currency: 'CHF' },
      category: 'Brot',
    },
  ],
  total: 2,
};

const mockStoresResponse = {
  stores: [
    {
      id: 'coop-store-1',
      name: 'Coop Zürich Bahnhofstrasse',
      city: 'Zürich',
      zip: '8001',
      street: 'Bahnhofstrasse',
      street_number: '10',
      latitude: 47.3769,
      longitude: 8.5417,
      opening_hours: 'Mo-Fr 08:00-20:00',
    },
    {
      id: 'coop-store-2',
      name: 'Coop Bern',
      city: 'Bern',
      zip: '3011',
      street: 'Spitalgasse',
      street_number: '3',
      latitude: 46.9480,
      longitude: 7.4474,
      opening_hours: 'Mo-Sa 08:00-18:00',
    },
  ],
  total: 2,
};

const mockProvenance = {
  provider: 'Coop',
  chain: 'coop' as const,
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

describe('CoopLiveAdapter', () => {
  let cache: ReturnType<typeof createMockCache>;
  let sourceClient: ReturnType<typeof createMockSourceClient>;
  let adapter: CoopLiveAdapter;

  beforeEach(() => {
    cache = createMockCache();
    sourceClient = createMockSourceClient();
    adapter = new CoopLiveAdapter({
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
      expect(sourceClient.fetchJson).toHaveBeenCalled();
    });

    it('returns error when fetch fails and no cache', async () => {
      cache.get.mockResolvedValue(undefined);
      sourceClient.fetchJson.mockRejectedValue(
        new SourceClientError(SourceWarningCode.SourceUnavailable, 'HTTP 503: Service Unavailable', SEARCH_API_URL, 503)
      );

      const result = await adapter.searchProducts({ query: 'Milch' });

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
    it('returns not supported', () => {
      const support = adapter.getStoreAvailabilitySupport();
      expect(support).toEqual({
        chain: 'coop',
        supported: false,
        reason: 'Coop store-level product availability is not yet implemented.',
      });
    });
  });

  describe('lookupStoreProductAvailability', () => {
    it('returns not supported', async () => {
      const result = await adapter.lookupStoreProductAvailability({
        storeId: 'coop-zurich',
        query: 'Milch',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.supported).toBe(false);
        expect(result.data.isAvailable).toBe(false);
      }
    });
  });
});
