import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { LidlLiveAdapter } from './lidlLiveAdapter.js';
import { SourceWarningCode } from '../types.js';

vi.mock('./lidlBrowser.js', () => ({
  searchProducts: vi.fn().mockResolvedValue([]),
}));

function createMockCache() {
  return {
    get: vi.fn(),
    set: vi.fn(),
  } as unknown as FileTtlCache;
}

const mockSearchHtml = `
<html>
<body>
<div data-gridbox-impression="${encodeURIComponent(JSON.stringify({
  id: '10054750',
  name: 'Vollmilch',
  price: 1.49,
  category: 'Food',
  categoryPrimary: 'Food',
}))}" data-qa-label="product-grid-box-link-10054750">
  <a href="/p/de-CH/vollmilch/p10054750">
    <img src="https://example.com/image.jpg" />
  </a>
  <div class="brand">Test Brand</div>
</div>
<div data-gridbox-impression="${encodeURIComponent(JSON.stringify({
  id: '10054753',
  name: 'Vollmilch Bio',
  price: 1.99,
  category: 'Food',
  categoryPrimary: 'Food',
}))}" data-qa-label="product-grid-box-link-10054753">
  <a href="/p/de-CH/vollmilch-bio/p10054753">
    <img src="https://example.com/image2.jpg" />
  </a>
  <div class="brand">Qualité Suisse</div>
</div>
</body>
</html>
`;

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

const mockCacheRecord = {
  expiresAt: '2026-06-17T10:00:00.000Z',
};

const mockStaleCacheHit = {
  data: [
    { id: '10054750', name: 'Vollmilch', price: { current: 1.49, currency: 'CHF' }, sourceUrl: 'https://www.lidl.ch/p/de-CH/vollmilch/p10054750' },
  ],
  provenance: {
    provider: 'Lidl Schweiz',
    chain: 'lidl' as const,
    sourceType: 'retailer-web' as const,
    sourceUrl: 'https://www.lidl.ch/q/de-CH/search',
    observedAt: '2026-06-15T10:00:00.000Z',
    freshness: 'stale' as const,
    confidence: 'medium' as const,
    cacheExpiresAt: '2026-06-15T10:00:00.000Z',
  },
  observedAt: '2026-06-15T10:00:00.000Z',
  expiresAt: '2026-06-15T10:00:00.000Z',
  isStale: true,
};

describe('LidlLiveAdapter', () => {
  let cache: ReturnType<typeof createMockCache>;
  let adapter: LidlLiveAdapter;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    cache = createMockCache();
    adapter = new LidlLiveAdapter({ cache });
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('searchProducts', () => {
    it('returns error on empty query', async () => {
      const result = await adapter.searchProducts({ query: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_QUERY');
      }
    });

    it('returns products on valid HTML response', async () => {
      cache.get.mockResolvedValue(undefined);
      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(mockSearchHtml),
      } as Response);
      cache.set.mockResolvedValue(mockCacheRecord);

      const result = await adapter.searchProducts({ query: 'Milch' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBe(2);
        expect(result.data[0].name).toBe('Vollmilch');
        expect(result.data[0].price.current).toBe(1.49);
      }
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('lidl.ch/q/de-CH/search'),
        expect.any(Object)
      );
    });

    it('returns error when fetch fails and no cache', async () => {
      cache.get.mockResolvedValue(undefined);
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error('HTTP 503: Service Unavailable'));

      const result = await adapter.searchProducts({ query: 'Milch' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(SourceWarningCode.SourceParseFailed);
      }
    });

    it('falls back to stale cache on fetch failure', async () => {
      cache.get.mockResolvedValue(mockStaleCacheHit);
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error('HTTP 503: Service Unavailable'));

      const result = await adapter.searchProducts({ query: 'Milch' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBe(1);
        expect(result.data[0].name).toBe('Vollmilch');
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
      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockStoresResponse),
      } as Response);
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
