import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { SourceHttpClient, SourceClientError } from '../../sources/sourceClient.js';
import { LidlLiveAdapter } from './lidlLiveAdapter.js';
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

const LEAFLET_URL = 'https://www.lidl.ch/de/angebote';
const STORES_URL = 'https://www.lidl.ch/de/filialfinder';

const mockLeafletHtml = `
<html>
<body>
  <div class="product-tile">
    <div class="product-title">Lidl Milch</div>
    <span>CHF 1.20</span>
  </div>
  <div class="product-tile">
    <div class="product-title">Lidl Brot</div>
    <span>CHF 2.50</span>
  </div>
</body>
</html>
`;

const mockStoresHtml = `
<html>
<body>
  <div class="store-item" data-lat="47.3769" data-lng="8.5417">
    <div class="store-name">Lidl Zürich</div>
    <div class="store-address">Bahnhofstrasse 1, 8001 Zürich</div>
    <div class="store-hours">Mo-Fr 08:00-20:00</div>
  </div>
  <div class="store-item" data-lat="46.9480" data-lng="7.4474">
    <div class="store-name">Lidl Bern</div>
    <div class="store-address">Spitalgasse 5, 3011 Bern</div>
  </div>
</body>
</html>
`;

const mockProvenance = {
  provider: 'Lidl Schweiz',
  chain: 'lidl' as const,
  sourceType: 'retailer-web' as const,
  sourceUrl: LEAFLET_URL,
  observedAt: '2026-06-16T10:00:00.000Z',
  freshness: 'live' as const,
  confidence: 'medium' as const,
};

const mockCacheRecord = {
  expiresAt: '2026-06-17T10:00:00.000Z',
};

const mockStaleCacheHit = {
  data: mockLeafletHtml,
  provenance: { ...mockProvenance, freshness: 'stale' as const, cacheExpiresAt: '2026-06-15T10:00:00.000Z' },
  observedAt: '2026-06-15T10:00:00.000Z',
  expiresAt: '2026-06-15T10:00:00.000Z',
  isStale: true,
};

describe('LidlLiveAdapter', () => {
  let cache: ReturnType<typeof createMockCache>;
  let sourceClient: ReturnType<typeof createMockSourceClient>;
  let adapter: LidlLiveAdapter;

  beforeEach(() => {
    cache = createMockCache();
    sourceClient = createMockSourceClient();
    adapter = new LidlLiveAdapter({
      cache,
      sourceClient,
      leafletUrl: LEAFLET_URL,
      storesUrl: STORES_URL,
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

    it('returns products on valid HTML response', async () => {
      cache.get.mockResolvedValue(undefined);
      sourceClient.fetchText.mockResolvedValue({
        data: mockLeafletHtml,
        provenance: mockProvenance,
      });
      cache.set.mockResolvedValue(mockCacheRecord);

      const result = await adapter.searchProducts({ query: 'Milch' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBeGreaterThan(0);
        expect(result.data[0]).toMatchObject({
          chain: 'lidl',
          price: { current: 1.20 },
        });
      }
      expect(sourceClient.fetchText).toHaveBeenCalled();
    });

    it('returns error when fetch fails and no cache', async () => {
      cache.get.mockResolvedValue(undefined);
      sourceClient.fetchText.mockRejectedValue(
        new SourceClientError(SourceWarningCode.SourceUnavailable, 'HTTP 503: Service Unavailable', LEAFLET_URL, 503)
      );

      const result = await adapter.searchProducts({ query: 'Milch' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(SourceWarningCode.SourceUnavailable);
      }
    });

    it('falls back to stale cache on fetch failure', async () => {
      cache.get.mockResolvedValue(mockStaleCacheHit);
      sourceClient.fetchText.mockRejectedValue(
        new SourceClientError(SourceWarningCode.SourceUnavailable, 'HTTP 503: Service Unavailable', LEAFLET_URL, 503)
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

    it('returns stores on valid HTML response', async () => {
      cache.get.mockResolvedValue(undefined);
      sourceClient.fetchText.mockResolvedValue({
        data: mockStoresHtml,
        provenance: { ...mockProvenance, sourceUrl: STORES_URL },
      });
      cache.set.mockResolvedValue(mockCacheRecord);

      const result = await adapter.findStores({ location: 'Zürich' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBe(2);
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
