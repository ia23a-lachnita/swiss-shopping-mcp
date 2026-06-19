import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import {
  Chain,
  ChainAdapter,
  NormalizedProduct,
  NormalizedStore,
  ProductSearchFilters,
  PromotionSearchFilters,
  Result,
  StoreAvailabilitySupport,
  StoreProductAvailabilityFilters,
  StoreProductAvailabilityResult,
  StoreSearchFilters,
} from '../adapters/types.js';
import { SearchService } from '../services/searchService.js';
import { PriceComparisonService } from '../services/priceComparisonService.js';

// ---------------------------------------------------------------------------
// Mock adapters
// ---------------------------------------------------------------------------

function product(overrides: Partial<NormalizedProduct> & { id: string; name: string; chain: Chain }): NormalizedProduct {
  return {
    brand: 'TestBrand',
    price: { current: 1.5 },
    category: 'dairy',
    ...overrides,
  };
}

function store(overrides: Partial<NormalizedStore> & { id: string; name: string; chain: Chain }): NormalizedStore {
  return {
    address: 'Teststrasse 1, 8000 Zurich',
    location: { latitude: 47.37, longitude: 8.54 },
    ...overrides,
  };
}

const MIGROS_MILK = product({ id: 'mig-1', chain: 'migros', name: 'Migros Vollmilch 1L', price: { current: 1.65 } });
const COOP_MILK = product({ id: 'coop-1', chain: 'coop', name: 'Coop Vitalit Milk 1L', price: { current: 1.75 } });
const MIGROS_STORE_ZURICH = store({ id: 'mig-s1', chain: 'migros', name: 'Migros Zurich HB', address: 'Bahnhofstrasse 1, 8001 Zurich', openingHours: '08:00-20:00' });
const MIGROS_STORE_BERN = store({ id: 'mig-s2', chain: 'migros', name: 'Migros Bern', address: 'Marktgasse 1, 3011 Bern', openingHours: '09:00-18:00' });
const COOP_STORE_ZURICH = store({ id: 'coop-s1', chain: 'coop', name: 'Coop Zurich HB', address: 'Bahnhofstrasse 2, 8001 Zurich', openingHours: '07:00-21:00' });
const COOP_STORE_BERN = store({ id: 'coop-s2', chain: 'coop', name: 'Coop Bern', address: 'Spitalgasse 1, 3011 Bern', openingHours: '08:00-19:00' });

const ALL_MIGROS_PRODUCTS = [MIGROS_MILK];
const ALL_COOP_PRODUCTS = [COOP_MILK];
const ALL_MIGROS_STORES = [MIGROS_STORE_ZURICH, MIGROS_STORE_BERN];
const ALL_COOP_STORES = [COOP_STORE_ZURICH, COOP_STORE_BERN];

function createMockAdapter(
  chain: Chain,
  products: NormalizedProduct[],
  stores: NormalizedStore[],
): ChainAdapter {
  return {
    chain,
    async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
      const q = filters.query.trim().toLowerCase();
      let results = products.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.brand && p.brand.toLowerCase().includes(q))
      );
      if (typeof filters.maxPrice === 'number') {
        results = results.filter((p) => p.price.current <= filters.maxPrice!);
      }
      if (typeof filters.limit === 'number') {
        results = results.slice(0, filters.limit);
      }
      return { ok: true, data: results };
    },
    async searchPromotions(_filters: PromotionSearchFilters) {
      return { ok: true, data: [] };
    },
    async findStores(filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
      const loc = filters.location.trim().toLowerCase();
      let results = stores.filter(
        (s) =>
          s.address.toLowerCase().includes(loc) ||
          s.name.toLowerCase().includes(loc)
      );
      if (typeof filters.limit === 'number') {
        results = results.slice(0, filters.limit);
      }
      return { ok: true, data: results };
    },
    getStoreAvailabilitySupport(): StoreAvailabilitySupport {
      return { chain, supported: true };
    },
    async lookupStoreProductAvailability(
      filters: StoreProductAvailabilityFilters
    ): Promise<Result<StoreProductAvailabilityResult>> {
      const match = products.find(
        (p) => p.name.toLowerCase().includes(filters.query.trim().toLowerCase())
      );
      return {
        ok: true,
        data: {
          chain,
          storeId: filters.storeId,
          query: filters.query,
          supported: true,
          matches: match ? [{ product: match, available: true }] : [],
          isAvailable: !!match,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Test server setup (same handler logic as server.ts, but injected adapters)
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function parseBody<T>(raw: string): { ok: true; data: T } | { ok: false; error: string } {
  try {
    const data = JSON.parse(raw) as T;
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'Invalid JSON body.' };
  }
}

function createTestServer(adapters: ChainAdapter[]) {
  const searchService = new SearchService(adapters);
  const priceComparisonService = new PriceComparisonService(adapters);

  return createHttpServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost:0');

    try {
      // POST /api/search-products
      if (req.method === 'POST' && url.pathname === '/api/search-products') {
        const body = await readBody(req);
        const parsed = parseBody<{
          query: string;
          chains?: Chain[];
          maxPrice?: number;
          category?: string;
          limit?: number;
        }>(body);
        if (!parsed.ok) {
          sendJson(res, 400, { ok: false, error: { code: 'INVALID_BODY', message: parsed.error } });
          return;
        }
        const { query, chains, maxPrice, category, limit } = parsed.data;
        if (!query || typeof query !== 'string') {
          sendJson(res, 400, { ok: false, error: { code: 'INVALID_QUERY', message: 'Query is required.' } });
          return;
        }
        const result = await searchService.searchProducts({ query, chains, maxPrice, category, limit });
        if (result.ok) {
          sendJson(res, 200, { ok: true, data: result.data, metadata: result.metadata });
        } else {
          sendJson(res, 500, { ok: false, error: result.error });
        }
        return;
      }

      // POST /api/find-stores
      if (req.method === 'POST' && url.pathname === '/api/find-stores') {
        const body = await readBody(req);
        const parsed = parseBody<{ location: string; chains?: Chain[]; limit?: number }>(body);
        if (!parsed.ok) {
          sendJson(res, 400, { ok: false, error: { code: 'INVALID_BODY', message: parsed.error } });
          return;
        }
        const { location, chains, limit } = parsed.data;
        if (!location || typeof location !== 'string') {
          sendJson(res, 400, { ok: false, error: { code: 'INVALID_LOCATION', message: 'Location is required.' } });
          return;
        }
        const result = await searchService.findStores({ location, chains, limit });
        if (result.ok) {
          sendJson(res, 200, { ok: true, data: result.data, metadata: result.metadata });
        } else {
          sendJson(res, 500, { ok: false, error: result.error });
        }
        return;
      }

      // POST /api/compare-prices
      if (req.method === 'POST' && url.pathname === '/api/compare-prices') {
        const body = await readBody(req);
        const parsed = parseBody<{
          query: string;
          chains?: Chain[];
          quantity?: number;
        }>(body);
        if (!parsed.ok) {
          sendJson(res, 400, { ok: false, error: { code: 'INVALID_BODY', message: parsed.error } });
          return;
        }
        const { query, chains, quantity } = parsed.data;
        if (!query || typeof query !== 'string') {
          sendJson(res, 400, { ok: false, error: { code: 'INVALID_QUERY', message: 'Query is required.' } });
          return;
        }
        const result = await priceComparisonService.comparePrices({ query, chains, quantity });
        if (result.ok) {
          sendJson(res, 200, { ok: true, data: result.data, metadata: result.metadata });
        } else {
          sendJson(res, 500, { ok: false, error: result.error });
        }
        return;
      }

      // GET /api/source-status
      if (req.method === 'GET' && url.pathname === '/api/source-status') {
        const { getAllCapabilityStatuses } = await import('../adapters/sourceRegistry.js');
        sendJson(res, 200, { ok: true, data: getAllCapabilityStatuses() });
        return;
      }

      // POST /api/store-availability
      if (req.method === 'POST' && url.pathname === '/api/store-availability') {
        const body = await readBody(req);
        const parsed = parseBody<{
          query: string;
          location: string;
          chains?: Chain[];
          inStockOnly?: boolean;
          openNow?: boolean;
          limit?: number;
        }>(body);
        if (!parsed.ok) {
          sendJson(res, 400, { ok: false, error: { code: 'INVALID_BODY', message: parsed.error } });
          return;
        }
        const { query, location } = parsed.data;
        if (!query || !location) {
          sendJson(res, 400, { ok: false, error: { code: 'INVALID_PARAMS', message: 'query and location are required.' } });
          return;
        }
        const result = await searchService.lookupAvailabilityByLocation(parsed.data);
        if (result.ok) {
          sendJson(res, 200, { ok: true, data: result.data });
        } else {
          sendJson(res, 500, { ok: false, error: result.error });
        }
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: 'Internal server error.' } });
      }
    }
  });
}

function post(url: string, body: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const req = fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    req.then(async (r) => {
      const json = await r.json();
      resolve({ status: r.status, data: json });
    }).catch(reject);
  });
}

function get(url: string): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    fetch(url).then(async (r) => {
      const json = await r.json();
      resolve({ status: r.status, data: json });
    }).catch(reject);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Web server integration (SPA endpoints)', () => {
  let server: ReturnType<typeof createHttpServer>;
  let baseUrl: string;

  beforeAll(async () => {
    const migrosAdapter = createMockAdapter('migros', ALL_MIGROS_PRODUCTS, ALL_MIGROS_STORES);
    const coopAdapter = createMockAdapter('coop', ALL_COOP_PRODUCTS, ALL_COOP_STORES);
    server = createTestServer([migrosAdapter, coopAdapter]);
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ---- 1. Store finder with city names ----
  describe('Store finder with city names', () => {
    it('returns ok with data when searching for a city name like "Bern"', async () => {
      const res = await post(`${baseUrl}/api/find-stores`, { location: 'Bern' });
      expect(res.status).toBe(200);
      const body = res.data as { ok: boolean; data: unknown[] };
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
    });

    it('returns ok with empty results for an unknown city', async () => {
      const res = await post(`${baseUrl}/api/find-stores`, { location: 'Atlantis' });
      expect(res.status).toBe(200);
      const body = res.data as { ok: boolean; data: unknown[] };
      expect(body.ok).toBe(true);
      expect(body.data).toEqual([]);
    });
  });

  // ---- 2. Store finder with postal codes ----
  describe('Store finder with postal codes', () => {
    it('returns stores when searching with a postal code', async () => {
      const res = await post(`${baseUrl}/api/find-stores`, { location: '8001' });
      expect(res.status).toBe(200);
      const body = res.data as { ok: boolean; data: { chain: string }[] };
      expect(body.ok).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
      const chains = new Set(body.data.map((s) => s.chain));
      expect(chains.has('migros') || chains.has('coop')).toBe(true);
    });
  });

  // ---- 3. Product search with special characters ----
  describe('Product search with special characters', () => {
    it('returns ok without crashing on XSS-like input', async () => {
      const res = await post(`${baseUrl}/api/search-products`, {
        query: '<script>alert(1)</script>',
      });
      expect(res.status).toBe(200);
      const body = res.data as { ok: boolean; data: unknown[] };
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
    });
  });

  // ---- 4. Price comparison with quantity ----
  describe('Price comparison with quantity', () => {
    it('returns correct totalPrice when quantity is 2', async () => {
      const res = await post(`${baseUrl}/api/compare-prices`, {
        query: 'milk',
        quantity: 2,
      });
      expect(res.status).toBe(200);
      const body = res.data as {
        ok: boolean;
        data: { quantity: number; offers: { totalPrice: number; effectivePrice: number }[] };
      };
      expect(body.ok).toBe(true);
      expect(body.data.quantity).toBe(2);
      for (const offer of body.data.offers) {
        expect(offer.totalPrice).toBeCloseTo(offer.effectivePrice * 2, 2);
      }
    });
  });

  // ---- 5. Availability with openNow filter ----
  describe('Availability with openNow filter', () => {
    it('only returns stores where isOpen is true when openNow is set', async () => {
      const res = await post(`${baseUrl}/api/store-availability`, {
        query: 'milk',
        location: '8001',
        openNow: true,
      });
      expect(res.status).toBe(200);
      const body = res.data as {
        ok: boolean;
        data: { isOpen?: boolean }[];
      };
      expect(body.ok).toBe(true);
      for (const store of body.data) {
        expect(store.isOpen).not.toBe(false);
      }
    });
  });

  // ---- 6. Availability with inStockOnly filter ----
  describe('Availability with inStockOnly filter', () => {
    it('only returns stores where available is true when inStockOnly is set', async () => {
      const res = await post(`${baseUrl}/api/store-availability`, {
        query: 'milk',
        location: '8001',
        inStockOnly: true,
      });
      expect(res.status).toBe(200);
      const body = res.data as {
        ok: boolean;
        data: { available: boolean }[];
      };
      expect(body.ok).toBe(true);
      for (const store of body.data) {
        expect(store.available).toBe(true);
      }
    });
  });

  // ---- 7. Source status returns all chains ----
  describe('Source status returns all chains', () => {
    it('returns entries for all 7 retail chains', async () => {
      const res = await get(`${baseUrl}/api/source-status`);
      expect(res.status).toBe(200);
      const body = res.data as { ok: boolean; data: { chain: string }[] };
      expect(body.ok).toBe(true);
      const chains = new Set(body.data.map((entry) => entry.chain));
      expect(chains.has('migros')).toBe(true);
      expect(chains.has('coop')).toBe(true);
      expect(chains.has('aldi')).toBe(true);
      expect(chains.has('denner')).toBe(true);
      expect(chains.has('lidl')).toBe(true);
      expect(chains.has('volg')).toBe(true);
      expect(chains.has('ottos')).toBe(true);
    });
  });

  // ---- 8. Search with maxPrice filter ----
  describe('Search with maxPrice filter', () => {
    it('only returns products with price <= maxPrice', async () => {
      const res = await post(`${baseUrl}/api/search-products`, {
        query: 'milk',
        maxPrice: 1.0,
      });
      expect(res.status).toBe(200);
      const body = res.data as {
        ok: boolean;
        data: { price: { current: number } }[];
      };
      expect(body.ok).toBe(true);
      for (const p of body.data) {
        expect(p.price.current).toBeLessThanOrEqual(1.0);
      }
    });
  });

  // ---- 9. Empty query returns error ----
  describe('Empty query returns error', () => {
    it('returns 400 with ok: false for empty query', async () => {
      const res = await post(`${baseUrl}/api/search-products`, { query: '' });
      expect(res.status).toBe(400);
      const body = res.data as { ok: boolean; error: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INVALID_QUERY');
    });
  });

  // ---- 10. Missing location returns error ----
  describe('Missing location returns error', () => {
    it('returns 400 when location is missing from store-availability', async () => {
      const res = await post(`${baseUrl}/api/store-availability`, { query: 'milk' });
      expect(res.status).toBe(400);
      const body = res.data as { ok: boolean; error: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INVALID_PARAMS');
    });
  });

  // ---- 11. Search with chains parameter ----
  describe('Search with chains parameter', () => {
    it('only returns products from the specified chain', async () => {
      const res = await post(`${baseUrl}/api/search-products`, {
        query: 'milk',
        chains: ['coop'],
      });
      expect(res.status).toBe(200);
      const body = res.data as { ok: boolean; data: { chain: string }[] };
      expect(body.ok).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
      for (const p of body.data) {
        expect(p.chain).toBe('coop');
      }
    });
  });

  // ---- 12. Store availability chains parameter ----
  describe('Store availability chains parameter', () => {
    it('only returns stores from the specified chain', async () => {
      const res = await post(`${baseUrl}/api/store-availability`, {
        query: 'milk',
        location: '8001',
        chains: ['migros'],
      });
      expect(res.status).toBe(200);
      const body = res.data as { ok: boolean; data: { chain: string }[] };
      expect(body.ok).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
      for (const s of body.data) {
        expect(s.chain).toBe('migros');
      }
    });
  });
});
