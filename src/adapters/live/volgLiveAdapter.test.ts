import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { VolgLiveAdapter } from './volgLiveAdapter.js';
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

function createMockCache() {
  return {
    get: vi.fn(),
    set: vi.fn(),
  } as unknown as FileTtlCache;
}

const SOURCE_URL = 'https://www.volgshop.ch/wp-json/wc/store/v1/products';

const mockSearchResponse = [
  {
    id: 'volg-001',
    name: 'Volg Vollmilch',
    prices: { price: '160', currency_code: 'CHF', currency_minor_unit: 2 },
    categories: [{ name: 'Milchprodukte' }],
    images: [{ src: 'https://example.com/volg-milk.jpg' }],
  },
  {
    id: 'volg-002',
    name: 'Volg Butter',
    prices: { price: '280', currency_code: 'CHF', currency_minor_unit: 2 },
    categories: [{ name: 'Milchprodukte' }],
    images: [],
  },
];

const mockProvenance = {
  provider: 'Volg',
  chain: 'volg' as const,
  sourceType: 'retailer-web' as const,
  sourceUrl: SOURCE_URL,
  observedAt: '2026-06-16T10:00:00.000Z',
  freshness: 'live' as const,
  confidence: 'medium' as const,
};

const mockCacheRecord = {
  expiresAt: '2026-06-17T10:00:00.000Z',
};

const mockStaleCacheHit = {
  data: mockSearchResponse,
  provenance: { ...mockProvenance, freshness: 'stale' as const, cacheExpiresAt: '2026-06-15T10:00:00.000Z' },
  observedAt: '2026-06-15T10:00:00.000Z',
  expiresAt: '2026-06-15T10:00:00.000Z',
  isStale: true,
};

describe('VolgLiveAdapter', () => {
  let cache: ReturnType<typeof createMockCache>;
  let adapter: VolgLiveAdapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mocks: any;

  beforeEach(async () => {
    cache = createMockCache();
    adapter = new VolgLiveAdapter({ cache });

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
          chain: 'volg',
          name: 'Volg Vollmilch',
          price: { current: 1.60 },
        });
      }
      expect(mocks.mockFetchJson).toHaveBeenCalled();
    });

    it('returns error when fetch fails and no cache', async () => {
      cache.get.mockResolvedValue(undefined);
      mocks.mockFetchJson.mockRejectedValue(
        new (await import('../../sources/sourceClient.js')).SourceClientError(
          SourceWarningCode.SourceUnavailable,
          'HTTP 503: Service Unavailable',
          SOURCE_URL,
          503,
        ),
      );

      const result = await adapter.searchProducts({ query: 'Milch' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(SourceWarningCode.SourceUnavailable);
      }
    });

    it('falls back to stale cache on fetch failure', async () => {
      cache.get.mockResolvedValue(mockStaleCacheHit);
      mocks.mockFetchJson.mockRejectedValue(
        new (await import('../../sources/sourceClient.js')).SourceClientError(
          SourceWarningCode.SourceUnavailable,
          'HTTP 503: Service Unavailable',
          SOURCE_URL,
          503,
        ),
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
    it('returns empty array on empty location (delivery-only)', async () => {
      const result = await adapter.findStores({ location: '' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual([]);
      }
    });

    it('returns empty array (delivery-only)', async () => {
      const result = await adapter.findStores({ location: 'Zürich' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual([]);
      }
    });
  });

  describe('searchPromotions', () => {
    it('returns not-implemented', async () => {
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
        reason: 'Volgshop is a delivery-only service.',
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
