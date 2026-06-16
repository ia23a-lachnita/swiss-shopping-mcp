import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { SourceHttpClient, SourceClientError } from '../../sources/sourceClient.js';
import { VolgLiveAdapter } from './volgLiveAdapter.js';
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

const SEARCH_API_URL = 'https://www.volgshop.ch/de/search';
const STORES_API_URL = 'https://www.volg.ch/de/filialfinder';

const mockSearchResponse = [
  {
    id: 'volg-001',
    name: 'Volg Vollmilch',
    brand: 'Volg',
    price: { amount: 1.40, currency: 'CHF' },
    category: 'Milchprodukte',
    image_url: 'https://example.com/volg-milk.jpg',
    on_sale: true,
  },
  {
    id: 'volg-002',
    name: 'Volg Emmentaler',
    brand: 'Volg',
    price: { amount: 4.50, currency: 'CHF' },
    category: 'Käse',
  },
];

const mockStoresResponse = [
  {
    id: 'volg-store-1',
    name: 'Volg Zürich Seefeld',
    city: 'Zürich',
    zip: '8008',
    street: 'Seefeldstrasse',
    street_number: '50',
    latitude: 47.3620,
    longitude: 8.5580,
    opening_hours: 'Mo-Fr 07:00-19:00',
  },
  {
    id: 'volg-store-2',
    name: 'Volg Luzern',
    city: 'Luzern',
    zip: '6004',
    street: 'Pilatusstrasse',
    street_number: '20',
    latitude: 47.0502,
    longitude: 8.3093,
    opening_hours: 'Mo-Sa 07:00-19:00',
  },
];

const mockProvenance = {
  provider: 'Volg',
  chain: 'volg' as const,
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

describe('VolgLiveAdapter', () => {
  let cache: ReturnType<typeof createMockCache>;
  let sourceClient: ReturnType<typeof createMockSourceClient>;
  let adapter: VolgLiveAdapter;

  beforeEach(() => {
    cache = createMockCache();
    sourceClient = createMockSourceClient();
    adapter = new VolgLiveAdapter({
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
          chain: 'volg',
          name: 'Volg Vollmilch',
          price: { current: 1.40 },
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
          chain: 'volg',
          name: 'Volg Zürich Seefeld',
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
        chain: 'volg',
        supported: false,
        reason: 'Volg does not expose store-level product availability.',
      });
    });
  });

  describe('lookupStoreProductAvailability', () => {
    it('returns not supported', async () => {
      const result = await adapter.lookupStoreProductAvailability({
        storeId: 'volg-zurich',
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
