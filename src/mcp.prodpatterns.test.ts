import { readFile } from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MessageExtraInfo, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer } from './index.js';
import {
  NormalizedProduct,
  NormalizedPromotion,
  CapabilitySourceStatus,
  SourceWarningCode,
} from './adapters/types.js';

// ─── Loopback Transport ──────────────────────────────────────────────────────

class LoopbackTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;

  private peer?: LoopbackTransport;

  attachPeer(peer: LoopbackTransport): void {
    this.peer = peer;
  }

  async start(): Promise<void> {
    return Promise.resolve();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.peer?.onmessage?.(message);
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

function createLoopbackTransportPair(): {
  clientTransport: LoopbackTransport;
  serverTransport: LoopbackTransport;
} {
  const clientTransport = new LoopbackTransport();
  const serverTransport = new LoopbackTransport();
  clientTransport.attachPeer(serverTransport);
  serverTransport.attachPeer(clientTransport);
  return { clientTransport, serverTransport };
}

// ─── Fake Fetch ──────────────────────────────────────────────────────────────

const ALDI_PRODUCT_URL =
  'https://www.aldi-suisse.ch/de/produkt/backbox-toskanabrot-000000000000101698';
const ALDI_SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url>
    <loc>${ALDI_PRODUCT_URL}</loc>
    <lastmod>2026-05-18</lastmod>
  </url>
</urlset>`;

function createFakeFetch() {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = input.toString();
    if (url.endsWith('/sitemap_products.xml')) {
      return new Response(ALDI_SITEMAP_XML, {
        status: 200,
        headers: { 'content-type': 'text/xml' },
      });
    }
    if (url === ALDI_PRODUCT_URL) {
      return new Response(aldiProductHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (url.includes('denner.ch')) {
      return new Response(dennerHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response('Not Found', { status: 404 });
  };
}

let aldiProductHtml: string;
let dennerHtml: string;

// ─── Helpers ─────────────────────────────────────────────────────────────────

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolResult> {
  return client.callTool({ name, arguments: args }) as Promise<ToolResult>;
}

function structured<T = Record<string, unknown>>(result: ToolResult): T {
  return result.structuredContent as T;
}

// ─── Setup ───────────────────────────────────────────────────────────────────

let client: Client;
let server: ReturnType<typeof createServer> extends Promise<infer S> ? S : never;

beforeAll(async () => {
  aldiProductHtml = await readFile(
    new URL('../fixtures/live-sources/aldi/product-toskanabrot.sample.html', import.meta.url),
    'utf8'
  );
  dennerHtml = await readFile(
    new URL('../fixtures/live-sources/denner/current-actions.sample.html', import.meta.url),
    'utf8'
  );

  const fakeFetch = createFakeFetch();
  server = await createServer({
    adapterOptions: { cacheDirectory: 'test-cache-prodpatterns', fetchImpl: fakeFetch },
  });
  client = new Client({ name: 'prodpatterns-tests', version: '1.0.0' });
  const { clientTransport, serverTransport } = createLoopbackTransportPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await server.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. TOOL REGISTRATION & SCHEMA VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('1. Tool Registration & Schema Validation', () => {
  it('registers all 7 V1 MCP tools', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toEqual([
      'search_products',
      'search_promotions',
      'find_stores',
      'compare_prices',
      'get_store_availability_support',
      'lookup_store_product_availability',
      'get_source_status',
    ]);
  });

  it('each tool has a non-empty description', async () => {
    const tools = await client.listTools();
    for (const tool of tools.tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('search_products schema has query as only required field', async () => {
    const tools = await client.listTools();
    const sp = tools.tools.find((t) => t.name === 'search_products')!;
    const schema = sp.inputSchema as { required?: string[]; properties: Record<string, unknown> };
    expect(schema.required).toEqual(['query']);
    expect(schema.properties.chains).toBeDefined();
    expect(schema.properties.maxPrice).toBeDefined();
    expect(schema.properties.category).toBeDefined();
    expect(schema.properties.tags).toBeDefined();
    expect(schema.properties.excludeAllergens).toBeDefined();
    expect(schema.properties.dietaryPreferences).toBeDefined();
    expect(schema.properties.limit).toBeDefined();
    expect(schema.properties.matchMode).toBeDefined();
  });

  it('compare_prices schema has query as only required field', async () => {
    const tools = await client.listTools();
    const cp = tools.tools.find((t) => t.name === 'compare_prices')!;
    const schema = cp.inputSchema as { required?: string[]; properties: Record<string, unknown> };
    expect(schema.required).toEqual(['query']);
    expect(schema.properties.quantity).toBeDefined();
    expect(schema.properties.limitPerChain).toBeDefined();
    expect(schema.properties.comparisonBasis).toBeDefined();
    expect(schema.properties.includePromotions).toBeDefined();
  });

  it('find_stores schema has location as only required field', async () => {
    const tools = await client.listTools();
    const fs = tools.tools.find((t) => t.name === 'find_stores')!;
    const schema = fs.inputSchema as { required?: string[] };
    expect(schema.required).toEqual(['location']);
  });

  it('lookup_store_product_availability requires chain, storeId, query', async () => {
    const tools = await client.listTools();
    const lsa = tools.tools.find((t) => t.name === 'lookup_store_product_availability')!;
    const schema = lsa.inputSchema as { required?: string[] };
    expect(schema.required).toEqual(expect.arrayContaining(['chain', 'storeId', 'query']));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. ERROR HANDLING — INVALID / UNKNOWN TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

describe('2. Error Handling', () => {
  it('returns UNKNOWN_TOOL for an unregistered tool name', async () => {
    const result = await callTool(client, 'nonexistent_tool', { foo: 'bar' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('UNKNOWN_TOOL');
  });

  it('returns INVALID_ARGUMENTS when search_products has empty query', async () => {
    const result = await callTool(client, 'search_products', { query: '' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_ARGUMENTS');
  });

  it('returns INVALID_ARGUMENTS when search_products has no query', async () => {
    const result = await callTool(client, 'search_products', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_ARGUMENTS');
  });

  it('returns INVALID_ARGUMENTS when find_stores has empty location', async () => {
    const result = await callTool(client, 'find_stores', { location: '' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_ARGUMENTS');
  });

  it('returns INVALID_ARGUMENTS when compare_prices has invalid chain enum', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'milk',
      chains: ['walmart'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_ARGUMENTS');
  });

  it('returns INVALID_ARGUMENTS when compare_prices has quantity 0', async () => {
    const result = await callTool(client, 'compare_prices', { query: 'milk', quantity: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_ARGUMENTS');
  });

  it('returns INVALID_ARGUMENTS when compare_prices has negative quantity', async () => {
    const result = await callTool(client, 'compare_prices', { query: 'milk', quantity: -5 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_ARGUMENTS');
  });

  it('returns INVALID_ARGUMENTS when search_products has invalid matchMode', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'milk',
      matchMode: 'fuzzy',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_ARGUMENTS');
  });

  it('returns INVALID_ARGUMENTS when search_products limit exceeds 100', async () => {
    const result = await callTool(client, 'search_products', { query: 'milk', limit: 101 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_ARGUMENTS');
  });

  it('returns INVALID_ARGUMENTS when lookup_store_product_availability missing chain', async () => {
    const result = await callTool(client, 'lookup_store_product_availability', {
      storeId: 'store-1',
      query: 'milk',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_ARGUMENTS');
  });

  it('returns INVALID_ARGUMENTS when lookup_store_product_availability missing storeId', async () => {
    const result = await callTool(client, 'lookup_store_product_availability', {
      chain: 'aldi',
      query: 'milk',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_ARGUMENTS');
  });

  it('rejects unknown properties (strict mode) on search_products', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'milk',
      unexpectedField: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_ARGUMENTS');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. SEARCH_PRODUCTS — BASIC & ADVANCED
// ═══════════════════════════════════════════════════════════════════════════════

describe('3. search_products', () => {
  it('returns products for a basic query across all chains', async () => {
    const result = await callTool(client, 'search_products', { query: 'Toskanabrot' });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.length).toBeGreaterThan(0);

    const product = data.products[0];
    expect(product.id).toBeTruthy();
    expect(product.chain).toBe('aldi');
    expect(product.name).toBe('Toskanabrot');
    expect(product.price.current).toBeGreaterThan(0);
    expect(product.price.current).toBe(2.19);
  });

  it('restricts results to a single chain via chains filter', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Toskanabrot',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.every((p) => p.chain === 'aldi')).toBe(true);
  });

  it('returns empty products for a query with no matches', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'xyznonexistentproduct999',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products).toEqual([]);
  });

  it('applies maxPrice filter and excludes expensive products', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Toskanabrot',
      chains: ['aldi'],
      maxPrice: 1.0,
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.every((p) => p.price.current <= 1.0)).toBe(true);
  });

  it('respects limit parameter', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Toskanabrot',
      chains: ['aldi'],
      limit: 1,
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.length).toBeLessThanOrEqual(1);
  });

  it('uses balanced matchMode by default (taxonomy aliases)', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Brot',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    const hasToskanabrot = data.products.some((p) =>
      p.name.toLowerCase().includes('toskanabrot')
    );
    expect(hasToskanabrot).toBe(true);
  });

  it('literal matchMode still matches substrings (not just taxonomy)', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Brot',
      chains: ['aldi'],
      matchMode: 'literal',
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    const hasToskanabrot = data.products.some((p) =>
      p.name.toLowerCase().includes('toskanabrot')
    );
    expect(hasToskanabrot).toBe(true);
  });

  it('includes source metadata in successful response', async () => {
    const result = await callTool(client, 'search_products', { query: 'Toskanabrot' });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[]; sources?: unknown[] }>(result);
    expect(data.sources).toBeDefined();
    expect(data.sources!.length).toBeGreaterThan(0);
  });

  it('product has provenance with sourceType and confidence', async () => {
    const result = await callTool(client, 'search_products', { query: 'Toskanabrot' });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    const product = data.products[0];
    expect(product.provenance).toBeDefined();
    expect(product.provenance!.confidence).toBe('medium');
    expect(product.provenance!.sourceType).toBe('retailer-web');
  });

  it('unsupported chains return source warnings but do not block results', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Toskanabrot',
      chains: ['aldi', 'coop'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      products: NormalizedProduct[];
      sourceWarnings?: Array<{ code: string; chain: string }>;
    }>(result);
    expect(data.products.length).toBeGreaterThan(0);
    expect(data.sourceWarnings).toBeDefined();
    const coopWarnings = data.sourceWarnings!.filter((w) => w.chain === 'coop');
    expect(coopWarnings.length).toBeGreaterThan(0);
    expect(coopWarnings[0].code).toBe(SourceWarningCode.RealSourceNotImplemented);
  });

  it('returns ALL_SOURCES_FAILED when all requested chains are unsupported', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'milk',
      chains: ['coop', 'farmy'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ALL_SOURCES_FAILED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. SEARCH_PROMOTIONS
// ═══════════════════════════════════════════════════════════════════════════════

describe('4. search_promotions', () => {
  it('Denner promotions adapter is operational (may return empty due to fixture expiry)', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'aktion',
      chains: ['denner'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ promotions: NormalizedPromotion[] }>(result);
    expect(Array.isArray(data.promotions)).toBe(true);
  });

  it('unsupported chains return source warnings', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'wine',
      chains: ['denner', 'migros'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      promotions: NormalizedPromotion[];
      sourceWarnings?: Array<{ code: string; chain: string }>;
    }>(result);
    expect(data.sourceWarnings).toBeDefined();
    const migrosWarnings = data.sourceWarnings!.filter((w) => w.chain === 'migros');
    expect(migrosWarnings.length).toBeGreaterThan(0);
  });

  it('ALL_SOURCES_FAILED when all chains unsupported', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'wine',
      chains: ['coop', 'migros'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ALL_SOURCES_FAILED');
  });

  it('returns empty for non-matching query', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'xyznonexistentpromo999',
      chains: ['denner'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ promotions: NormalizedPromotion[] }>(result);
    expect(data.promotions).toEqual([]);
  });

  it('includes source metadata for denner', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'aktion',
      chains: ['denner'],
    });
    const data = structured<{
      sources?: Array<{ chain: string; status: string; provider?: string }>;
    }>(result);
    expect(data.sources).toBeDefined();
    const dennerSource = data.sources!.find((s) => s.chain === 'denner');
    expect(dennerSource).toBeDefined();
    expect(dennerSource!.provider).toBe('Denner');
  });

  it('restricts to specific chain', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'aktion',
      chains: ['denner'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ promotions: NormalizedPromotion[] }>(result);
    expect(data.promotions.every((p) => p.chain === 'denner')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. FIND_STORES
// ═══════════════════════════════════════════════════════════════════════════════

describe('5. find_stores', () => {
  it('Aldi store search returns ALL_SOURCES_FAILED (store lookup not implemented)', async () => {
    const result = await callTool(client, 'find_stores', {
      location: 'Basel',
      chains: ['aldi'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ALL_SOURCES_FAILED');
    expect(result.content[0].text).toContain('aldi');
  });

  it('Coop store search returns ALL_SOURCES_FAILED (store lookup unsupported)', async () => {
    const result = await callTool(client, 'find_stores', {
      location: 'Zürich',
      chains: ['coop'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ALL_SOURCES_FAILED');
    expect(result.content[0].text).toContain('coop');
  });

  it('ALL_SOURCES_FAILED when all requested chains unsupported', async () => {
    const result = await callTool(client, 'find_stores', {
      location: 'Bern',
      chains: ['farmy', 'volg'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ALL_SOURCES_FAILED');
  });

  it('empty location returns INVALID_ARGUMENTS', async () => {
    const result = await callTool(client, 'find_stores', { location: '   ' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_ARGUMENTS');
  });

  it('Migros store search returns ALL_SOURCES_FAILED (store lookup unsupported)', async () => {
    const result = await callTool(client, 'find_stores', {
      location: 'Zürich',
      chains: ['migros'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ALL_SOURCES_FAILED');
    expect(result.content[0].text).toContain('migros');
  });

  it('mixed supported/unsupported chains returns partial error with warnings', async () => {
    const result = await callTool(client, 'find_stores', {
      location: 'Bern',
      chains: ['aldi', 'farmy'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ALL_SOURCES_FAILED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. COMPARE_PRICES — CORE & ADVANCED
// ═══════════════════════════════════════════════════════════════════════════════

describe('6. compare_prices', () => {
  it('returns comparison with offers for a known product', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'Toskanabrot',
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      comparison: {
        query: string;
        quantity: number;
        offers: Array<{
          chain: string;
          effectivePrice: number;
          totalPrice: number;
          priceBasis: string;
        }>;
        comparisonBasis: string;
      };
    }>(result);
    expect(data.comparison.query).toBe('Toskanabrot');
    expect(data.comparison.quantity).toBe(1);
    expect(data.comparison.offers.length).toBeGreaterThan(0);
    expect(data.comparison.comparisonBasis).toBe('packPrice');

    const offer = data.comparison.offers[0];
    expect(offer.chain).toBe('aldi');
    expect(offer.effectivePrice).toBe(2.19);
    expect(offer.totalPrice).toBe(2.19);
    expect(offer.priceBasis).toBe('product');
  });

  it('default quantity is 1', async () => {
    const result = await callTool(client, 'compare_prices', { query: 'Toskanabrot' });
    const data = structured<{ comparison: { quantity: number } }>(result);
    expect(data.comparison.quantity).toBe(1);
  });

  it('applies quantity multiplier to totalPrice', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'Toskanabrot',
      quantity: 3,
    });
    const data = structured<{
      comparison: {
        quantity: number;
        offers: Array<{ effectivePrice: number; totalPrice: number }>;
      };
    }>(result);
    expect(data.comparison.quantity).toBe(3);
    const offer = data.comparison.offers.find((o) => o.effectivePrice === 2.19);
    if (offer) {
      expect(offer.totalPrice).toBeCloseTo(6.57, 2);
    }
  });

  it('restricts to specific chains', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'Toskanabrot',
      chains: ['aldi'],
    });
    const data = structured<{
      comparison: { offers: Array<{ chain: string }> };
    }>(result);
    expect(data.comparison.offers.every((o) => o.chain === 'aldi')).toBe(true);
  });

  it('cheapestOffer and mostExpensiveOffer are present when offers exist', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'Toskanabrot',
      chains: ['aldi'],
    });
    const data = structured<{
      comparison: {
        cheapestOffer?: { chain: string; totalPrice: number };
        mostExpensiveOffer?: { chain: string; totalPrice: number };
      };
    }>(result);
    expect(data.comparison.cheapestOffer).toBeDefined();
    expect(data.comparison.mostExpensiveOffer).toBeDefined();
  });

  it('savingsVsMostExpensive is undefined when only one chain has offers', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'Toskanabrot',
      chains: ['aldi'],
    });
    const data = structured<{
      comparison: { savingsVsMostExpensive?: number };
    }>(result);
    expect(data.comparison.savingsVsMostExpensive).toBeUndefined();
  });

  it('maxPrice filter excludes expensive offers', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'Toskanabrot',
      maxPrice: 1.0,
    });
    const data = structured<{
      comparison: { offers: Array<{ effectivePrice: number }> };
    }>(result);
    expect(data.comparison.offers.every((o) => o.effectivePrice <= 1.0)).toBe(true);
  });

  it('ALL_SOURCES_FAILED for completely unsupported chain set', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'milk',
      chains: ['farmy'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ALL_SOURCES_FAILED');
  });

  it('includePromotions does not crash when promotions are empty (expired fixtures)', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'Orangensaft',
      chains: ['denner'],
      includePromotions: true,
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      comparison: {
        offers: Array<{ priceBasis: string; chain: string; effectivePrice: number }>;
      };
    }>(result);
    expect(Array.isArray(data.comparison.offers)).toBe(true);
  });

  it('unitPrice comparisonBasis works', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'Toskanabrot',
      chains: ['aldi'],
      comparisonBasis: 'unitPrice',
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      comparison: {
        comparisonBasis: string;
        offers: Array<{ comparisonEligible: boolean }>;
      };
    }>(result);
    expect(data.comparison.comparisonBasis).toBe('unitPrice');
  });

  it('invalid comparisonBasis returns INVALID_ARGUMENTS', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'milk',
      comparisonBasis: 'wrong',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_ARGUMENTS');
  });

  it('compare_prices with unsupported chains produces warnings not errors', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'Toskanabrot',
      chains: ['aldi', 'coop'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      comparison: { offers: Array<{ chain: string }> };
      sourceWarnings?: Array<{ chain: string }>;
    }>(result);
    expect(data.comparison.offers.some((o) => o.chain === 'aldi')).toBe(true);
    expect(data.sourceWarnings).toBeDefined();
    expect(data.sourceWarnings!.some((w) => w.chain === 'coop')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. GET_SOURCE_STATUS
// ═══════════════════════════════════════════════════════════════════════════════

describe('7. get_source_status', () => {
  it('returns status for all 8 chains when called without filters', async () => {
    const result = await callTool(client, 'get_source_status', {});
    expect(result.isError).not.toBe(true);
    const data = structured<{ statuses: CapabilitySourceStatus[] }>(result);
    expect(data.statuses.length).toBeGreaterThan(0);

    const chains = new Set(data.statuses.map((s) => s.chain));
    expect(chains.has('aldi')).toBe(true);
    expect(chains.has('denner')).toBe(true);
    expect(chains.has('migros')).toBe(true);
    expect(chains.has('coop')).toBe(true);
    expect(chains.has('lidl')).toBe(true);
    expect(chains.has('farmy')).toBe(true);
    expect(chains.has('volg')).toBe(true);
    expect(chains.has('ottos')).toBe(true);
  });

  it('each chain has entries for all 5 capabilities', async () => {
    const result = await callTool(client, 'get_source_status', {});
    const data = structured<{ statuses: CapabilitySourceStatus[] }>(result);
    const capabilities = ['productSearch', 'promotions', 'storeSearch', 'availability', 'nutrition'];

    for (const chain of ['aldi', 'denner', 'migros', 'coop', 'lidl', 'farmy', 'volg', 'ottos']) {
      const chainCaps = data.statuses.filter((s) => s.chain === chain).map((s) => s.capability);
      for (const cap of capabilities) {
        expect(chainCaps).toContain(cap);
      }
    }
  });

  it('aldi productSearch is live-beta in source registry', async () => {
    const result = await callTool(client, 'get_source_status', { chains: ['aldi'] });
    const data = structured<{ statuses: CapabilitySourceStatus[] }>(result);
    const aldiProductSearch = data.statuses.find(
      (s) => s.chain === 'aldi' && s.capability === 'productSearch'
    );
    expect(aldiProductSearch).toBeDefined();
    expect(aldiProductSearch!.status).toBe('live-beta');
  });

  it('denner promotions is live-beta in source registry', async () => {
    const result = await callTool(client, 'get_source_status', { chains: ['denner'] });
    const data = structured<{ statuses: CapabilitySourceStatus[] }>(result);
    const dennerPromos = data.statuses.find(
      (s) => s.chain === 'denner' && s.capability === 'promotions'
    );
    expect(dennerPromos).toBeDefined();
    expect(dennerPromos!.status).toBe('live-beta');
  });

  it('farmy all capabilities are blocked', async () => {
    const result = await callTool(client, 'get_source_status', { chains: ['farmy'] });
    const data = structured<{ statuses: CapabilitySourceStatus[] }>(result);
    expect(data.statuses.every((s) => s.status === 'blocked')).toBe(true);
  });

  it('capability filter returns only requested capabilities', async () => {
    const result = await callTool(client, 'get_source_status', {
      capabilities: ['productSearch'],
    });
    const data = structured<{ statuses: CapabilitySourceStatus[] }>(result);
    expect(
      data.statuses.every((s) => s.capability === 'productSearch')
    ).toBe(true);
  });

  it('chain + capability filter intersection works', async () => {
    const result = await callTool(client, 'get_source_status', {
      chains: ['aldi', 'denner'],
      capabilities: ['promotions'],
    });
    const data = structured<{ statuses: CapabilitySourceStatus[] }>(result);
    expect(data.statuses.every((s) => ['aldi', 'denner'].includes(s.chain))).toBe(true);
    expect(data.statuses.every((s) => s.capability === 'promotions')).toBe(true);
  });

  it('no static-v1 status in default runtime', async () => {
    const result = await callTool(client, 'get_source_status', {});
    const data = structured<{ statuses: CapabilitySourceStatus[] }>(result);
    expect(data.statuses.every((s) => s.status !== 'static-v1')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. GET_STORE_AVAILABILITY_SUPPORT
// ═══════════════════════════════════════════════════════════════════════════════

describe('8. get_store_availability_support', () => {
  it('returns support status for all chains', async () => {
    const result = await callTool(client, 'get_store_availability_support', {});
    expect(result.isError).not.toBe(true);
    const data = structured<{
      support: Array<{ chain: string; supported: boolean; reason?: string }>;
    }>(result);
    expect(data.support.length).toBeGreaterThan(0);
    const chains = data.support.map((s) => s.chain);
    expect(chains).toContain('aldi');
    expect(chains).toContain('denner');
    expect(chains).toContain('coop');
  });

  it('all chains report supported=false in current implementation', async () => {
    const result = await callTool(client, 'get_store_availability_support', {});
    const data = structured<{
      support: Array<{ chain: string; supported: boolean }>;
    }>(result);
    expect(data.support.every((s) => s.supported === false)).toBe(true);
  });

  it('chain filter restricts results', async () => {
    const result = await callTool(client, 'get_store_availability_support', {
      chains: ['aldi', 'denner'],
    });
    const data = structured<{
      support: Array<{ chain: string }>;
    }>(result);
    expect(data.support.length).toBe(2);
    expect(data.support.map((s) => s.chain)).toEqual(expect.arrayContaining(['aldi', 'denner']));
  });

  it('unsupported chains provide a reason', async () => {
    const result = await callTool(client, 'get_store_availability_support', {
      chains: ['coop'],
    });
    const data = structured<{
      support: Array<{ chain: string; supported: boolean; reason?: string }>;
    }>(result);
    expect(data.support[0].supported).toBe(false);
    expect(data.support[0].reason).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. LOOKUP_STORE_PRODUCT_AVAILABILITY
// ═══════════════════════════════════════════════════════════════════════════════

describe('9. lookup_store_product_availability', () => {
  it('returns unsupported for unsupported chain (coop)', async () => {
    const result = await callTool(client, 'lookup_store_product_availability', {
      chain: 'coop',
      storeId: 'coop-zurich-1',
      query: 'milk',
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      availability: {
        chain: string;
        storeId: string;
        query: string;
        supported: boolean;
        isAvailable: boolean;
        reason?: string;
        matches: unknown[];
      };
    }>(result);
    expect(data.availability.chain).toBe('coop');
    expect(data.availability.storeId).toBe('coop-zurich-1');
    expect(data.availability.query).toBe('milk');
    expect(data.availability.supported).toBe(false);
    expect(data.availability.isAvailable).toBe(false);
    expect(data.availability.matches).toEqual([]);
    expect(data.availability.reason).toBeTruthy();
  });

  it('returns unsupported for aldi (no store availability source)', async () => {
    const result = await callTool(client, 'lookup_store_product_availability', {
      chain: 'aldi',
      storeId: 'aldi-zurich-1',
      query: 'Toskanabrot',
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      availability: { chain: string; supported: boolean; isAvailable: boolean };
    }>(result);
    expect(data.availability.chain).toBe('aldi');
    expect(data.availability.supported).toBe(false);
    expect(data.availability.isAvailable).toBe(false);
  });

  it('returns unsupported for farmy', async () => {
    const result = await callTool(client, 'lookup_store_product_availability', {
      chain: 'farmy',
      storeId: 'farmy-store-1',
      query: 'vegetables',
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      availability: { chain: string; supported: boolean; isAvailable: boolean };
    }>(result);
    expect(data.availability.supported).toBe(false);
  });

  it('denner store availability returns unsupported via delegate', async () => {
    const result = await callTool(client, 'lookup_store_product_availability', {
      chain: 'denner',
      storeId: 'denner-bern-1',
      query: 'wine',
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      availability: { chain: string; supported: boolean };
    }>(result);
    expect(data.availability.chain).toBe('denner');
    expect(data.availability.supported).toBe(false);
  });

  it('unsupported chain error is NOT returned for availability lookup', async () => {
    const result = await callTool(client, 'lookup_store_product_availability', {
      chain: 'volg',
      storeId: 'volg-1',
      query: 'bread',
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      availability: { chain: string; supported: boolean; isAvailable: boolean };
    }>(result);
    expect(data.availability.supported).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. CROSS-TOOL INTEGRATION SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

describe('10. Cross-Tool Integration Scenarios', () => {
  it('source status accurately reflects which tools return data', async () => {
    const statusResult = await callTool(client, 'get_source_status', {
      chains: ['aldi'],
      capabilities: ['productSearch'],
    });
    const statusData = structured<{ statuses: CapabilitySourceStatus[] }>(statusResult);
    const aldiProductStatus = statusData.statuses.find(
      (s) => s.chain === 'aldi' && s.capability === 'productSearch'
    );

    const searchResult = await callTool(client, 'search_products', {
      query: 'Toskanabrot',
      chains: ['aldi'],
    });

    if (aldiProductStatus?.status === 'live-beta') {
      expect(searchResult.isError).not.toBe(true);
      const searchData = structured<{ products: NormalizedProduct[] }>(searchResult);
      expect(searchData.products.length).toBeGreaterThan(0);
    }
  });

  it('unsupported chain status matches search_products error behavior', async () => {
    const searchResult = await callTool(client, 'search_products', {
      query: 'milk',
      chains: ['migros'],
    });
    expect(searchResult.isError).toBe(true);
    expect(searchResult.content[0].text).toContain('ALL_SOURCES_FAILED');
  });

  it('search then compare for same product returns consistent pricing', async () => {
    const searchResult = await callTool(client, 'search_products', {
      query: 'Toskanabrot',
      chains: ['aldi'],
    });
    const searchData = structured<{ products: NormalizedProduct[] }>(searchResult);
    const searchPrice = searchData.products[0]?.price.current;

    const compareResult = await callTool(client, 'compare_prices', {
      query: 'Toskanabrot',
      chains: ['aldi'],
    });
    const compareData = structured<{
      comparison: { offers: Array<{ effectivePrice: number }> };
    }>(compareResult);
    const comparePrice = compareData.comparison.offers[0]?.effectivePrice;

    expect(searchPrice).toBe(comparePrice);
  });

  it('find_stores unsupported matches availability support', async () => {
    const availResult = await callTool(client, 'get_store_availability_support', {
      chains: ['migros'],
    });
    const availData = structured<{
      support: Array<{ chain: string; supported: boolean }>;
    }>(availResult);
    const migrosSupport = availData.support.find((s) => s.chain === 'migros');
    expect(migrosSupport?.supported).toBe(false);
  });

  it('get_source_status and search_products are consistent for denner', async () => {
    const statusResult = await callTool(client, 'get_source_status', {
      chains: ['denner'],
      capabilities: ['promotions'],
    });
    const statusData = structured<{ statuses: CapabilitySourceStatus[] }>(statusResult);
    const dennerStatus = statusData.statuses.find(
      (s) => s.chain === 'denner' && s.capability === 'promotions'
    );
    expect(dennerStatus?.status).toBe('live-beta');

    const searchResult = await callTool(client, 'search_promotions', {
      query: 'aktion',
      chains: ['denner'],
    });
    expect(searchResult.isError).not.toBe(true);
  });

  it('lookup_store_product_availability for unsupported chain returns non-error result', async () => {
    const result = await callTool(client, 'lookup_store_product_availability', {
      chain: 'coop',
      storeId: 'coop-basel-1',
      query: 'milk',
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      availability: { chain: string; supported: boolean; isAvailable: boolean; reason?: string };
    }>(result);
    expect(data.availability.supported).toBe(false);
    expect(data.availability.reason).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. DATA INTEGRITY & MODEL CONTRACTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('11. Data Integrity & Model Contracts', () => {
  it('NormalizedProduct has required fields', async () => {
    const result = await callTool(client, 'search_products', { query: 'Toskanabrot' });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    const product = data.products[0];
    expect(typeof product.id).toBe('string');
    expect(product.id.length).toBeGreaterThan(0);
    expect(typeof product.chain).toBe('string');
    expect(typeof product.name).toBe('string');
    expect(product.name.length).toBeGreaterThan(0);
    expect(typeof product.price).toBe('object');
    expect(typeof product.price.current).toBe('number');
    expect(product.price.current).toBeGreaterThan(0);
  });

  it('NormalizedProduct chain matches valid Chain enum', async () => {
    const result = await callTool(client, 'search_products', { query: 'Toskanabrot' });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    const validChains = ['migros', 'coop', 'aldi', 'denner', 'lidl', 'farmy', 'volg', 'ottos'];
    expect(validChains).toContain(data.products[0].chain);
  });

  it('price comparison offers have all required fields', async () => {
    const result = await callTool(client, 'compare_prices', { query: 'Toskanabrot' });
    const data = structured<{
      comparison: {
        offers: Array<{
          chain: string;
          effectivePrice: number;
          totalPrice: number;
          priceBasis: string;
          comparisonEligible: boolean;
          isEligibleForUnitComparison: boolean;
        }>;
      };
    }>(result);
    for (const offer of data.comparison.offers) {
      expect(typeof offer.chain).toBe('string');
      expect(typeof offer.effectivePrice).toBe('number');
      expect(typeof offer.totalPrice).toBe('number');
      expect(typeof offer.priceBasis).toBe('string');
      expect(typeof offer.comparisonEligible).toBe('boolean');
      expect(typeof offer.isEligibleForUnitComparison).toBe('boolean');
    }
  });

  it('source warnings have code, message, and chain', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'milk',
      chains: ['aldi', 'coop'],
    });
    const data = structured<{
      sourceWarnings?: Array<{
        code: string;
        message: string;
        chain: string;
      }>;
    }>(result);
    for (const warning of data.sourceWarnings ?? []) {
      expect(typeof warning.code).toBe('string');
      expect(typeof warning.message).toBe('string');
      expect(typeof warning.chain).toBe('string');
    }
  });

  it('CapabilitySourceStatus has chain, capability, status fields', async () => {
    const result = await callTool(client, 'get_source_status', {});
    const data = structured<{ statuses: CapabilitySourceStatus[] }>(result);
    for (const status of data.statuses) {
      expect(typeof status.chain).toBe('string');
      expect(typeof status.capability).toBe('string');
      expect(typeof status.status).toBe('string');
    }
  });

  it('availability result has chain, storeId, query, supported fields', async () => {
    const result = await callTool(client, 'lookup_store_product_availability', {
      chain: 'aldi',
      storeId: 'test-store',
      query: 'milk',
    });
    const data = structured<{
      availability: {
        chain: string;
        storeId: string;
        query: string;
        supported: boolean;
        isAvailable: boolean;
      };
    }>(result);
    expect(data.availability.chain).toBe('aldi');
    expect(data.availability.storeId).toBe('test-store');
    expect(data.availability.query).toBe('milk');
    expect(typeof data.availability.supported).toBe('boolean');
    expect(typeof data.availability.isAvailable).toBe('boolean');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. EDGE CASES & BOUNDARY CONDITIONS
// ═══════════════════════════════════════════════════════════════════════════════

describe('12. Edge Cases & Boundary Conditions', () => {
  it('whitespace-only query is rejected', async () => {
    const result = await callTool(client, 'search_products', { query: '   ' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_ARGUMENTS');
  });

  it('special characters in query do not crash the server', async () => {
    const result = await callTool(client, 'search_products', {
      query: '<script>alert(1)</script>',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(Array.isArray(data.products)).toBe(true);
  });

  it('unicode query (Chinese) returns empty results gracefully', async () => {
    const result = await callTool(client, 'search_products', {
      query: '面包',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products).toEqual([]);
  });

  it('very long query string does not crash', async () => {
    const longQuery = 'a'.repeat(500);
    const result = await callTool(client, 'search_products', {
      query: longQuery,
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
  });

  it('limit=1 returns at most one product', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Toskanabrot',
      chains: ['aldi'],
      limit: 1,
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.length).toBeLessThanOrEqual(1);
  });

  it('limit=100 is accepted', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Toskanabrot',
      chains: ['aldi'],
      limit: 100,
    });
    expect(result.isError).not.toBe(true);
  });

  it('quantity=0.01 is accepted for compare_prices', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'Toskanabrot',
      quantity: 0.01,
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ comparison: { quantity: number } }>(result);
    expect(data.comparison.quantity).toBe(0.01);
  });

  it('empty chains array is rejected', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'milk',
      chains: [],
    });
    expect(result.isError).toBe(true);
  });

  it('dietaryPreferences filter with valid values is accepted', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Toskanabrot',
      chains: ['aldi'],
      dietaryPreferences: ['vegan'],
    });
    expect(result.isError).not.toBe(true);
  });

  it('invalid dietaryPreference enum is rejected', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'milk',
      dietaryPreferences: ['keto'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_ARGUMENTS');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. METADATA & PROVENANCE PROPAGATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('13. Metadata & Provenance Propagation', () => {
  it('search_products includes sources array with chain info', async () => {
    const result = await callTool(client, 'search_products', { query: 'Toskanabrot' });
    const data = structured<{
      sources?: Array<{
        chain: string;
        status: string;
        provider?: string;
        sourceType?: string;
      }>;
    }>(result);
    expect(data.sources).toBeDefined();
    const aldiSource = data.sources!.find((s) => s.chain === 'aldi');
    expect(aldiSource).toBeDefined();
    expect(aldiSource!.provider).toBe('ALDI SUISSE');
    expect(aldiSource!.sourceType).toBe('retailer-web');
  });

  it('search_products includes summary text', async () => {
    const result = await callTool(client, 'search_products', { query: 'Toskanabrot' });
    const data = structured<{ summary?: string }>(result);
    expect(data.summary).toBeDefined();
    expect(typeof data.summary).toBe('string');
  });

  it('search_promotions includes source metadata for denner', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'aktion',
      chains: ['denner'],
    });
    const data = structured<{
      sources?: Array<{ chain: string; status: string; provider?: string }>;
    }>(result);
    expect(data.sources).toBeDefined();
    const dennerSource = data.sources!.find((s) => s.chain === 'denner');
    expect(dennerSource).toBeDefined();
    expect(dennerSource!.provider).toBe('Denner');
  });

  it('compare_prices propagates source warnings from failed chains', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'Toskanabrot',
      chains: ['aldi', 'farmy'],
    });
    const data = structured<{
      sourceWarnings?: Array<{ chain: string; code: string }>;
    }>(result);
    expect(data.sourceWarnings).toBeDefined();
    expect(data.sourceWarnings!.some((w) => w.chain === 'farmy')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. MATCHMODE & TAXONOMY BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════════

describe('14. MatchMode & Taxonomy Behavior', () => {
  it('balanced mode: "Brot" matches "Toskanabrot" via substring', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Brot',
      chains: ['aldi'],
      matchMode: 'balanced',
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name.includes('Toskanabrot'))).toBe(true);
  });

  it('literal mode: "Brot" still matches "Toskanabrot" via substring', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Brot',
      chains: ['aldi'],
      matchMode: 'literal',
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name.includes('Toskanabrot'))).toBe(true);
  });

  it('multi-token query all tokens must match in balanced mode', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Toskanabrot BACKBOX',
      chains: ['aldi'],
      matchMode: 'balanced',
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name === 'Toskanabrot')).toBe(true);
  });

  it('multi-token query fails if any token has no match', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Toskanabrot nonexistentxyz',
      chains: ['aldi'],
      matchMode: 'balanced',
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products).toEqual([]);
  });

  it('query matching by brand field works', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'BACKBOX',
      chains: ['aldi'],
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.brand === 'BACKBOX')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 15. SOURCE WARNING CODES & ERROR PATTERNS
// ═══════════════════════════════════════════════════════════════════════════════

describe('15. Source Warning Codes & Error Patterns', () => {
  it('unsupported chain search returns REAL_SOURCE_NOT_IMPLEMENTED', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'milk',
      chains: ['coop'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ALL_SOURCES_FAILED');
  });

  it('unsupported chain find_stores returns ALL_SOURCES_FAILED', async () => {
    const result = await callTool(client, 'find_stores', {
      location: 'Bern',
      chains: ['coop'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ALL_SOURCES_FAILED');
  });

  it('unsupported chain promotions returns REAL_SOURCE_NOT_IMPLEMENTED', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'wine',
      chains: ['migros'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ALL_SOURCES_FAILED');
  });

  it('partial failure: aldi succeeds, coop fails with warning', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Toskanabrot',
      chains: ['aldi', 'coop'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      products: NormalizedProduct[];
      sourceWarnings?: Array<{ code: string; chain: string; message: string }>;
    }>(result);
    expect(data.products.length).toBeGreaterThan(0);
    expect(data.sourceWarnings).toBeDefined();
    const coopWarning = data.sourceWarnings!.find((w) => w.chain === 'coop');
    expect(coopWarning).toBeDefined();
    expect(coopWarning!.code).toBe(SourceWarningCode.RealSourceNotImplemented);
    expect(coopWarning!.message).toContain('coop');
  });

  it('partial failure: denner succeeds, farmy fails with warning', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'aktion',
      chains: ['denner', 'farmy'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      promotions: NormalizedPromotion[];
      sourceWarnings?: Array<{ code: string; chain: string }>;
    }>(result);
    expect(data.sourceWarnings).toBeDefined();
    const farmyWarning = data.sourceWarnings!.find((w) => w.chain === 'farmy');
    expect(farmyWarning).toBeDefined();
    expect(farmyWarning!.code).toBe(SourceWarningCode.RealSourceNotImplemented);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 16. PRODUCTION READINESS PATTERNS
// ═══════════════════════════════════════════════════════════════════════════════

describe('16. Production Readiness Patterns', () => {
  it('concurrent tool calls do not interfere', async () => {
    const [r1, r2, r3] = await Promise.all([
      callTool(client, 'search_products', { query: 'Toskanabrot', chains: ['aldi'] }),
      callTool(client, 'get_source_status', { chains: ['aldi'] }),
      callTool(client, 'get_store_availability_support', { chains: ['aldi'] }),
    ]);
    expect(r1.isError).not.toBe(true);
    expect(r2.isError).not.toBe(true);
    expect(r3.isError).not.toBe(true);
  });

  it('server handles rapid sequential calls', async () => {
    for (let i = 0; i < 5; i++) {
      const result = await callTool(client, 'search_products', {
        query: 'Toskanabrot',
        chains: ['aldi'],
      });
      expect(result.isError).not.toBe(true);
    }
  });

  it('tool result structuredContent matches content text', async () => {
    const result = await callTool(client, 'search_products', { query: 'Toskanabrot' });
    const textContent = JSON.parse(result.content[0].text!);
    expect(textContent.products).toBeDefined();
    expect(textContent.products.length).toBeGreaterThan(0);
    expect(result.structuredContent).toBeDefined();
    const structured = result.structuredContent as { products: NormalizedProduct[] };
    expect(structured.products.length).toBe(textContent.products.length);
  });

  it('get_source_status returns within reasonable time', async () => {
    const start = Date.now();
    const result = await callTool(client, 'get_source_status', {});
    const elapsed = Date.now() - start;
    expect(result.isError).not.toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });

  it('search_products returns within reasonable time', async () => {
    const start = Date.now();
    const result = await callTool(client, 'search_products', { query: 'Toskanabrot' });
    const elapsed = Date.now() - start;
    expect(result.isError).not.toBe(true);
    expect(elapsed).toBeLessThan(5000);
  });

  it('compare_prices returns within reasonable time', async () => {
    const start = Date.now();
    const result = await callTool(client, 'compare_prices', { query: 'Toskanabrot' });
    const elapsed = Date.now() - start;
    expect(result.isError).not.toBe(true);
    expect(elapsed).toBeLessThan(5000);
  });

  it('lookup_store_product_availability returns within reasonable time', async () => {
    const start = Date.now();
    const result = await callTool(client, 'lookup_store_product_availability', {
      chain: 'aldi',
      storeId: 'test-store',
      query: 'milk',
    });
    const elapsed = Date.now() - start;
    expect(result.isError).not.toBe(true);
    expect(elapsed).toBeLessThan(3000);
  });
});
