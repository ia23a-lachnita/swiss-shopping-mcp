import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { LidlLiveAdapter } from './lidlLiveAdapter.js';
import { SourceWarningCode } from '../types.js';

vi.mock('../../sources/sourceClient.js', () => {
  const mockFetchJson = vi.fn();
  const mockFetchText = vi.fn();
  return {
    SourceHttpClient: vi.fn().mockImplementation(() => ({
      fetchJson: mockFetchJson,
      fetchText: mockFetchText,
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
    __mocks: { mockFetchJson, mockFetchText },
  };
});

function createMockCache() {
  return {
    get: vi.fn(),
    set: vi.fn(),
  } as unknown as FileTtlCache;
}

const mockCampaignResponse = {
  campaignGroups: [
    {
      name: 'This Week at Lidl',
      items: [
        {
          id: 'lidl-001',
          name: 'Lidl Vollmilch',
          brand: 'Milbona',
          price: 1.35,
          category: 'Milchprodukte',
          image: 'https://example.com/lidl-milk.jpg',
        },
        {
          id: 'lidl-002',
          name: 'Lidl Butter',
          brand: 'Milbona',
          price: 2.49,
          category: 'Milchprodukte',
        },
      ],
    },
  ],
};

const mockStoresResponse = {
  stores: [
    {
      id: 'lidl-store-1',
      name: 'Lidl Zürich',
      city: 'Zürich',
      zip: '8001',
      street: 'Bahnhofstrasse',
      latitude: 47.3769,
      longitude: 8.5417,
      openingHours: 'Mo-Fr 08:00-20:00',
    },
  ],
};

const mockProvenance = {
  provider: 'Lidl Schweiz',
  chain: 'lidl' as const,
  sourceType: 'retailer-web' as const,
  sourceUrl: 'https://digital-leaflet.lidlplus.com/api/v1/CH/campaignGroups',
  observedAt: '2026-06-16T10:00:00.000Z',
  freshness: 'live' as const,
  confidence: 'medium' as const,
};

const mockCacheRecord = {
  expiresAt: '2026-06-17T10:00:00.000Z',
};

const mockStaleCacheHit = {
  data: mockCampaignResponse,
  provenance: { ...mockProvenance, freshness: 'stale' as const, cacheExpiresAt: '2026-06-15T10:00:00.000Z' },
  observedAt: '2026-06-15T10:00:00.000Z',
  expiresAt: '2026-06-15T10:00:00.000Z',
  isStale: true,
};

describe('LidlLiveAdapter', () => {
  let cache: ReturnType<typeof createMockCache>;
  let adapter: LidlLiveAdapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mocks: any;

  beforeEach(async () => {
    cache = createMockCache();
    adapter = new LidlLiveAdapter({ cache });

    const sourceClientModule = await import('../../sources/sourceClient.js');
    mocks = (sourceClientModule as unknown as { __mocks: { mockFetchJson: ReturnType<typeof vi.fn>; mockFetchText: ReturnType<typeof vi.fn> } }).__mocks;
    mocks.mockFetchJson.mockReset();
    mocks.mockFetchText.mockReset();
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
        data: mockCampaignResponse,
        provenance: mockProvenance,
      });
      cache.set.mockResolvedValue(mockCacheRecord);

      const result = await adapter.searchProducts({ query: 'Milch' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBeGreaterThan(0);
        expect(result.data[0]).toMatchObject({
          chain: 'lidl',
          name: 'Lidl Vollmilch',
          price: { current: 1.35 },
        });
      }
      expect(mocks.mockFetchJson).toHaveBeenCalled();
    });

    it('returns error when fetch fails and no cache', async () => {
      cache.get.mockResolvedValue(undefined);
      mocks.mockFetchJson.mockRejectedValue(new Error('HTTP 503: Service Unavailable'));

      const result = await adapter.searchProducts({ query: 'Milch' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(SourceWarningCode.SourceParseFailed);
      }
    });

    it('falls back to stale cache on fetch failure', async () => {
      cache.get.mockResolvedValue(mockStaleCacheHit);
      mocks.mockFetchJson.mockRejectedValue(new Error('HTTP 503: Service Unavailable'));

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
        provenance: { ...mockProvenance, sourceUrl: 'https://stores.lidlplus.com/api/v2/CH' },
      });
      cache.set.mockResolvedValue(mockCacheRecord);

      const result = await adapter.findStores({ location: 'Zürich' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBe(1);
        expect(result.data[0]).toMatchObject({
          chain: 'lidl',
          name: 'Lidl Zürich',
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
        chain: 'lidl',
        supported: false,
        reason: 'Lidl does not expose store-level product availability.',
      });
    });
  });

  describe('lookupStoreProductAvailability', () => {
    it('returns not supported', async () => {
      const result = await adapter.lookupStoreProductAvailability({
        storeId: 'lidl-zurich',
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
