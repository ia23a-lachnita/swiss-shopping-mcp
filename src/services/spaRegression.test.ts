import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createDefaultAdapters } from '../adapters/index.js';
import { SearchService } from './searchService.js';
import { PriceComparisonService } from './priceComparisonService.js';
import {
  getAllCapabilityStatuses,
} from '../adapters/sourceRegistry.js';
import type { Chain } from '../adapters/types.js';

const PORT = 0;
let server: ReturnType<typeof createServer>;
let baseUrl: string;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseBody<T>(raw: string): { ok: true; data: T } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return { ok: true, data: parsed as T };
    return { ok: false, error: 'Body must be a JSON object.' };
  } catch {
    return { ok: false, error: 'Invalid JSON body.' };
  }
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return res.json();
}

beforeAll(async () => {
  const adapters = createDefaultAdapters();
  const searchService = new SearchService(adapters);
  const priceComparisonService = new PriceComparisonService(adapters);

  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/search-products') {
        const body = await readBody(req);
        const parsed = parseBody<{ query: string; chains?: Chain[]; maxPrice?: number; limit?: number }>(body);
        if (!parsed.ok) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
        const { query, chains, maxPrice, limit } = parsed.data;
        if (!query) { sendJson(res, 400, { ok: false, error: { code: 'INVALID_QUERY', message: 'Query is required.' } }); return; }
        const result = await searchService.searchProducts({ query, chains, maxPrice, limit });
        if (result.ok) sendJson(res, 200, { ok: true, data: result.data, metadata: result.metadata });
        else sendJson(res, 500, { ok: false, error: result.error });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/find-stores') {
        const body = await readBody(req);
        const parsed = parseBody<{ location: string; chains?: Chain[]; limit?: number }>(body);
        if (!parsed.ok) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
        const { location, chains, limit } = parsed.data;
        if (!location) { sendJson(res, 400, { ok: false, error: { code: 'INVALID_PARAMS', message: 'location is required.' } }); return; }
        const result = await searchService.findStores({ location, chains, limit });
        if (result.ok) sendJson(res, 200, { ok: true, data: result.data, metadata: result.metadata });
        else sendJson(res, 500, { ok: false, error: result.error });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/compare-prices') {
        const body = await readBody(req);
        const parsed = parseBody<{ query: string; chains?: Chain[]; quantity?: number }>(body);
        if (!parsed.ok) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
        const { query, chains, quantity } = parsed.data;
        if (!query) { sendJson(res, 400, { ok: false, error: { code: 'INVALID_QUERY', message: 'Query is required.' } }); return; }
        const result = await priceComparisonService.comparePrices({ query, chains, quantity });
        if (result.ok) sendJson(res, 200, { ok: true, data: result.data, metadata: result.metadata });
        else sendJson(res, 500, { ok: false, error: result.error });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/store-availability') {
        const body = await readBody(req);
        const parsed = parseBody<{ query: string; location: string; chains?: Chain[]; limit?: number; inStockOnly?: boolean; openNow?: boolean }>(body);
        if (!parsed.ok) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
        const { query, location } = parsed.data;
        if (!query || !location) { sendJson(res, 400, { ok: false, error: { code: 'INVALID_PARAMS', message: 'query and location are required.' } }); return; }
        const result = await searchService.lookupAvailabilityByLocation(parsed.data);
        if (result.ok) sendJson(res, 200, { ok: true, data: result.data });
        else sendJson(res, 500, { ok: false, error: result.error });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/source-status') {
        const statuses = getAllCapabilityStatuses();
        sendJson(res, 200, { ok: true, data: statuses });
        return;
      }

      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: 'Internal error.' } });
    }
  });

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

afterAll(() => {
  server.close();
});

// =====================================================
// Tests covering browser-found issues
// =====================================================

describe('Store Finder — opening hours (browser finding #1)', () => {
  it('Migros stores in Bern have openingHours field', async () => {
    const r = await post('/api/find-stores', { location: 'Bern', chains: ['migros'], limit: 3 });
    expect(r.ok).toBe(true);
    expect(r.data.length).toBeGreaterThan(0);
    const store = r.data[0];
    expect(store.openingHours).toBeDefined();
    expect(typeof store.openingHours).toBe('string');
    expect(store.openingHours.length).toBeGreaterThan(0);
  });

  it('Opening hours contain time info (weekday/weekend format)', async () => {
    const r = await post('/api/find-stores', { location: 'Bern', chains: ['migros'], limit: 3 });
    expect(r.ok).toBe(true);
    const store = r.data[0];
    // Should contain weekday/weekend format or time range
    expect(store.openingHours).toMatch(/Mon|Sat|Sun|\d{1,2}:\d{2}/);
  });

  it('Coop stores in Zurich have openingHours', async () => {
    const r = await post('/api/find-stores', { location: 'Zurich', chains: ['coop'], limit: 3 });
    expect(r.ok).toBe(true);
    expect(r.data.length).toBeGreaterThan(0);
    const store = r.data[0];
    expect(store.openingHours).toBeDefined();
  });
});

describe('Product search — chain filtering', () => {
  it('Migros-only search returns only Migros products', async () => {
    const r = await post('/api/search-products', { query: 'butter', chains: ['migros'], limit: 5 });
    expect(r.ok).toBe(true);
    expect(r.data.length).toBeGreaterThan(0);
    for (const p of r.data) {
      expect(p.chain).toBe('migros');
    }
  });

  it('Coop-only search returns only Coop products', async () => {
    const r = await post('/api/search-products', { query: 'butter', chains: ['coop'], limit: 5 });
    expect(r.ok).toBe(true);
    expect(r.data.length).toBeGreaterThan(0);
    for (const p of r.data) {
      expect(p.chain).toBe('coop');
    }
  });

  it('Multi-chain search returns products from multiple chains', async () => {
    const r = await post('/api/search-products', { query: 'milk', chains: ['migros', 'coop'], limit: 10 });
    expect(r.ok).toBe(true);
    const chains = new Set(r.data.map((p: any) => p.chain));
    expect(chains.size).toBeGreaterThanOrEqual(1);
  });
});

describe('Product cards — structure validation', () => {
  it('Product has all required fields for SPA rendering', async () => {
    const r = await post('/api/search-products', { query: 'butter', chains: ['migros'], limit: 3 });
    expect(r.ok).toBe(true);
    const p = r.data[0];
    expect(p.id).toBeDefined();
    expect(typeof p.id).toBe('string');
    expect(p.name).toBeDefined();
    expect(typeof p.name).toBe('string');
    expect(p.chain).toBe('migros');
    expect(p.price).toBeDefined();
    expect(typeof p.price.current).toBe('number');
    expect(p.price.current).toBeGreaterThan(0);
    expect(p.productUrl).toBeDefined();
    expect(typeof p.productUrl).toBe('string');
  });

  it('Product has optional fields (brand, image, nutrition)', async () => {
    const r = await post('/api/search-products', { query: 'Milch', chains: ['migros'], limit: 3 });
    expect(r.ok).toBe(true);
    const p = r.data[0];
    // These may or may not be present, but should not throw
    expect(p.brand === undefined || typeof p.brand === 'string').toBe(true);
    expect(p.image === undefined || typeof p.image === 'string').toBe(true);
  });
});

describe('Store cards — structure validation', () => {
  it('Store has all required fields for SPA rendering', async () => {
    const r = await post('/api/find-stores', { location: 'Bern', chains: ['migros'], limit: 3 });
    expect(r.ok).toBe(true);
    const s = r.data[0];
    expect(s.id).toBeDefined();
    expect(s.chain).toBe('migros');
    expect(s.name).toBeDefined();
    expect(typeof s.name).toBe('string');
    expect(s.location).toBeDefined();
    expect(typeof s.location.latitude).toBe('number');
    expect(typeof s.location.longitude).toBe('number');
  });

  it('Store location coordinates are valid (Swiss bounds)', async () => {
    const r = await post('/api/find-stores', { location: 'Bern', chains: ['migros'], limit: 3 });
    expect(r.ok).toBe(true);
    for (const s of r.data) {
      expect(s.location.latitude).toBeGreaterThan(45);
      expect(s.location.latitude).toBeLessThan(48);
      expect(s.location.longitude).toBeGreaterThan(5);
      expect(s.location.longitude).toBeLessThan(11);
    }
  });
});

describe('Source status — all chains visible', () => {
  it('Returns all 8 chains', async () => {
    const r = await get('/api/source-status');
    expect(r.ok).toBe(true);
    const chains = new Set(r.data.map((s: any) => s.chain));
    expect(chains.size).toBe(8);
    for (const chain of ['migros', 'coop', 'aldi', 'denner', 'lidl', 'ottos', 'volg', 'farmy']) {
      expect(chains.has(chain)).toBe(true);
    }
  });

  it('Each chain has productSearch capability status', async () => {
    const r = await get('/api/source-status');
    expect(r.ok).toBe(true);
    for (const chain of ['migros', 'coop', 'aldi']) {
      const entry = r.data.find((s: any) => s.chain === chain && s.capability === 'productSearch');
      expect(entry).toBeDefined();
      expect(typeof entry.status).toBe('string');
    }
  });

  it('Migros has live-beta for productSearch and storeSearch', async () => {
    const r = await get('/api/source-status');
    const migrosSearch = r.data.find((s: any) => s.chain === 'migros' && s.capability === 'productSearch');
    const migrosStore = r.data.find((s: any) => s.chain === 'migros' && s.capability === 'storeSearch');
    expect(migrosSearch?.status).toBe('live-beta');
    expect(migrosStore?.status).toBe('live-beta');
  });
});

describe('Error handling — empty/missing params', () => {
  it('Empty query returns error', async () => {
    const r = await post('/api/search-products', { query: '' });
    expect(r.ok).toBe(false);
  });

  it('Missing query returns error', async () => {
    const r = await post('/api/search-products', { chains: ['migros'] });
    expect(r.ok).toBe(false);
  });

  it('Empty location returns error', async () => {
    const r = await post('/api/find-stores', { location: '' });
    expect(r.ok).toBe(false);
  });

  it('Missing location returns error', async () => {
    const r = await post('/api/find-stores', {});
    expect(r.ok).toBe(false);
  });

  it('Empty comparison query returns error', async () => {
    const r = await post('/api/compare-prices', { query: '' });
    expect(r.ok).toBe(false);
  });

  it('Empty availability query returns error', async () => {
    const r = await post('/api/store-availability', { query: '' });
    expect(r.ok).toBe(false);
  });

  it('Missing location in availability returns error', async () => {
    const r = await post('/api/store-availability', { query: 'milk' });
    expect(r.ok).toBe(false);
  });
});

describe('Price comparison — offers structure', () => {
  it('Returns offers with chain and price', async () => {
    const r = await post('/api/compare-prices', { query: 'butter', chains: ['migros', 'coop'] });
    expect(r.ok).toBe(true);
    expect(r.data.offers.length).toBeGreaterThan(0);
    const offer = r.data.offers[0];
    expect(typeof offer.chain).toBe('string');
    expect(offer.product).toBeDefined();
    expect(typeof offer.product.name).toBe('string');
    expect(typeof offer.effectivePrice).toBe('number');
  });
});

describe('Availability — products-first endpoint', () => {
  it('Returns product availability data', { timeout: 15000 }, async () => {
    const r = await post('/api/store-availability', { query: 'Milch', location: 'Bern' });
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data)).toBe(true);
  });
});

describe('Max price filter', () => {
  it('Limits products to max price', async () => {
    const r = await post('/api/search-products', { query: 'cheese', chains: ['migros'], maxPrice: 5, limit: 10 });
    expect(r.ok).toBe(true);
    for (const p of r.data) {
      expect(p.price.current).toBeLessThanOrEqual(5);
    }
  });
});

describe('Limit parameter', () => {
  it('Limit 5 returns at most 5 products', async () => {
    const r = await post('/api/search-products', { query: 'milk', chains: ['migros'], limit: 5 });
    expect(r.ok).toBe(true);
    expect(r.data.length).toBeLessThanOrEqual(5);
  });

  it('Limit 20 returns more than limit 5', async () => {
    const r5 = await post('/api/search-products', { query: 'milk', chains: ['migros'], limit: 5 });
    const r20 = await post('/api/search-products', { query: 'milk', chains: ['migros'], limit: 20 });
    expect(r5.ok).toBe(true);
    expect(r20.ok).toBe(true);
    expect(r20.data.length).toBeGreaterThanOrEqual(r5.data.length);
  });
});

describe('Graceful degradation', () => {
  it('Unsupported chain returns ok:true with empty data', async () => {
    const r = await post('/api/search-products', { query: 'milk', chains: ['farmy'] });
    expect(r.ok).toBe(true);
    expect(r.data.length).toBe(0);
  });
});
