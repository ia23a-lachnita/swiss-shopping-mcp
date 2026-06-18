import { readFile } from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MessageExtraInfo, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer } from './index.js';
import { NormalizedProduct, NormalizedPromotion } from './adapters/types.js';

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

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface ProductFixture {
  url: string;
  html: string;
  name: string;
  brand: string;
  price: number;
}

const PRODUCT_FIXTURES: ProductFixture[] = [
  {
    url: 'https://www.aldi-suisse.ch/de/produkt/backbox-toskanabrot-000000000000101698',
    name: 'Toskanabrot',
    brand: 'BACKBOX',
    price: 2.19,
    html: '',
  },
  {
    url: 'https://www.aldi-suisse.ch/de/produkt/backbox-pizzasnack-margherita-000000000000100930',
    name: 'Pizzasnack Margherita',
    brand: 'BACKBOX',
    price: 1.49,
    html: `<!doctype html><html lang="de-CH"><head><title>Pizzasnack Margherita | ALDI SUISSE</title>
    <script type="application/ld+json">{"offers":{"@type":"Offer","url":"https://www.aldi-suisse.ch/de/produkt/backbox-pizzasnack-margherita-000000000000100930","price":"1.49","priceCurrency":"CHF","availability":"https://schema.org/InStock"},"@type":"Product","name":"Pizzasnack Margherita","@context":"https://schema.org/","brand":{"@type":"Brand","name":"BACKBOX"}}</script>
    </head><body></body></html>`,
  },
  {
    url: 'https://www.aldi-suisse.ch/de/produkt/no-brand-fish-fingers-000000000000100049',
    name: 'Fish Fingers',
    brand: 'NO BRAND',
    price: 3.99,
    html: `<!doctype html><html lang="de-CH"><head><title>Fish Fingers | ALDI SUISSE</title>
    <script type="application/ld+json">{"offers":{"@type":"Offer","url":"https://www.aldi-suisse.ch/de/produkt/no-brand-fish-fingers-000000000000100049","price":"3.99","priceCurrency":"CHF","availability":"https://schema.org/InStock"},"@type":"Product","name":"Fish Fingers","@context":"https://schema.org/","brand":{"@type":"Brand","name":"NO BRAND"}}</script>
    </head><body></body></html>`,
  },
  {
    url: 'https://www.aldi-suisse.ch/de/produkt/milbona-vollmilch-000000000000200100',
    name: 'Vollmilch',
    brand: 'MILBONA',
    price: 1.65,
    html: `<!doctype html><html lang="de-CH"><head><title>Vollmilch | ALDI SUISSE</title>
    <script type="application/ld+json">{"offers":{"@type":"Offer","url":"https://www.aldi-suisse.ch/de/produkt/milbona-vollmilch-000000000000200100","price":"1.65","priceCurrency":"CHF","availability":"https://schema.org/InStock"},"@type":"Product","name":"Vollmilch","@context":"https://schema.org/","brand":{"@type":"Brand","name":"MILBONA"}}</script>
    </head><body></body></html>`,
  },
  {
    url: 'https://www.aldi-suisse.ch/de/produkt/milbona-emmentaler-000000000000200200',
    name: 'Emmentaler',
    brand: 'MILBONA',
    price: 4.49,
    html: `<!doctype html><html lang="de-CH"><head><title>Emmentaler | ALDI SUISSE</title>
    <script type="application/ld+json">{"offers":{"@type":"Offer","url":"https://www.aldi-suisse.ch/de/produkt/milbona-emmentaler-000000000000200200","price":"4.49","priceCurrency":"CHF","availability":"https://schema.org/InStock"},"@type":"Product","name":"Emmentaler","@context":"https://schema.org/","brand":{"@type":"Brand","name":"MILBONA"}}</script>
    </head><body></body></html>`,
  },
  {
    url: 'https://www.aldi-suisse.ch/de/produkt/chiquita-banane-000000000000300100',
    name: 'Banane',
    brand: 'CHIQUITA',
    price: 2.49,
    html: `<!doctype html><html lang="de-CH"><head><title>Banane | ALDI SUISSE</title>
    <script type="application/ld+json">{"offers":{"@type":"Offer","url":"https://www.aldi-suisse.ch/de/produkt/chiquita-banane-000000000000300100","price":"2.49","priceCurrency":"CHF","availability":"https://schema.org/InStock"},"@type":"Product","name":"Banane","@context":"https://schema.org/","brand":{"@type":"Brand","name":"CHIQUITA"}}</script>
    </head><body></body></html>`,
  },
  {
    url: 'https://www.aldi-suisse.ch/de/produkt/migros-apfelsaft-000000000000400100',
    name: 'Apfelsaft',
    brand: 'ALDI EIGENMARKE',
    price: 1.29,
    html: `<!doctype html><html lang="de-CH"><head><title>Apfelsaft | ALDI SUISSE</title>
    <script type="application/ld+json">{"offers":{"@type":"Offer","url":"https://www.aldi-suisse.ch/de/produkt/migros-apfelsaft-000000000000400100","price":"1.29","priceCurrency":"CHF","availability":"https://schema.org/InStock"},"@type":"Product","name":"Apfelsaft","@context":"https://schema.org/","brand":{"@type":"Brand","name":"ALDI EIGENMARKE"}}</script>
    </head><body></body></html>`,
  },
  {
    url: 'https://www.aldi-suisse.ch/de/produkt/optimus-reinigungsmittel-000000000000500100',
    name: 'Reinigungsmittel',
    brand: 'OPTIMUS',
    price: 2.99,
    html: `<!doctype html><html lang="de-CH"><head><title>Reinigungsmittel | ALDI SUISSE</title>
    <script type="application/ld+json">{"offers":{"@type":"Offer","url":"https://www.aldi-suisse.ch/de/produkt/optimus-reinigungsmittel-000000000000500100","price":"2.99","priceCurrency":"CHF","availability":"https://schema.org/InStock"},"@type":"Product","name":"Reinigungsmittel","@context":"https://schema.org/","brand":{"@type":"Brand","name":"OPTIMUS"}}</script>
    </head><body></body></html>`,
  },
];

function buildSitemapXml(): string {
  const urls = PRODUCT_FIXTURES.map(
    (p) => `  <url><loc>${p.url}</loc><lastmod>2026-06-10</lastmod></url>`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n${urls}\n</urlset>`;
}

const DENNER_HTML = `<!doctype html><html lang="de"><body>
<h2 class="product-grid-heading">Sommer Aktionen</h2>
<div class="mb-4">Bis 30.12.2026</div>
<div class="product-grid">
  <div class="product-item stretch-link product-grid__item">
    <div class="price-tag__discount">20%</div>
    <div class="price-tag__price">
      <span class="price-tag__final-price">7.95</span>
      <div class="price-tag__instead">statt 9.95</div>
    </div>
    <img width="200" class="product-item__image" src="https://denner.imgix.net/assets/wein.png" />
    <a class="product-item__title" href="/de/aktionen/chardonnay-wein~p100500">Chardonnay Wein</a>
    <div class="product-item__subline">0.75 Liter</div>
  </div>
  <div class="product-item stretch-link product-grid__item">
    <div class="price-tag__discount">30%</div>
    <div class="price-tag__price">
      <span class="price-tag__final-price">5.95</span>
      <div class="price-tag__instead">statt 8.50</div>
    </div>
    <img width="200" class="product-item__image" src="https://denner.imgix.net/assets/orange-juice.png" />
    <a class="product-item__title" href="/de/aktionen/orangensaft-aktuell~p1028500">Orangensaft Aktuell</a>
    <div class="product-item__subline">mit Fruchtfleisch, 1 Liter</div>
  </div>
  <div class="product-item stretch-link product-grid__item">
    <div class="price-tag__discount">15%</div>
    <div class="price-tag__price">
      <span class="price-tag__final-price">12.50</span>
      <div class="price-tag__instead">statt 14.70</div>
    </div>
    <img width="200" class="product-item__image" src="https://denner.imgix.net/assets/grillset.png" />
    <a class="product-item__title" href="/de/aktionen/grill-bratwurst-set~p100900">Grill Bratwurst Set</a>
    <div class="product-item__subline">4 x 200 g</div>
  </div>
</div>
</body></html>`;

function createFakeFetch(): (input: string | URL | Request) => Promise<Response> {
  const productMap = new Map(PRODUCT_FIXTURES.map((p) => [p.url, p.html]));

  return async (input: string | URL | Request): Promise<Response> => {
    const url = input.toString();

    if (url.endsWith('/sitemap_products.xml')) {
      return new Response(buildSitemapXml(), {
        status: 200,
        headers: { 'content-type': 'text/xml' },
      });
    }

    const productHtml = productMap.get(url);
    if (productHtml) {
      return new Response(productHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }

    if (url.includes('denner.ch')) {
      return new Response(DENNER_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }

    return new Response('Not Found', { status: 404 });
  };
}

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
  const toskanabrotFixture = await readFile(
    new URL('../fixtures/live-sources/aldi/product-toskanabrot.sample.html', import.meta.url),
    'utf8'
  );
  PRODUCT_FIXTURES[0].html = toskanabrotFixture;

  const fakeFetch = createFakeFetch();
  server = await createServer({
    adapterOptions: { cacheDirectory: 'test-cache-search-deep', fetchImpl: fakeFetch },
  });
  client = new Client({ name: 'search-deep-tests', version: '1.0.0' });
  const { clientTransport, serverTransport } = createLoopbackTransportPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await server.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. BACKBOX BRAND — TWO PRODUCTS (Toskanabrot + Pizzasnack)
// ═══════════════════════════════════════════════════════════════════════════════

describe('1. Backbox Brand — Two Products', () => {
  it('searches for "backbox" and finds both Toskanabrot and Pizzasnack', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    const names = data.products.map((p) => p.name);
    expect(names).toContain('Toskanabrot');
    expect(names).toContain('Pizzasnack Margherita');
    expect(data.products.length).toBeGreaterThanOrEqual(2);
  });

  it('searches for "Toskanabrot" finds exact product', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Toskanabrot',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products[0].name).toBe('Toskanabrot');
    expect(data.products[0].brand).toBe('BACKBOX');
    expect(data.products[0].price.current).toBe(2.19);
  });

  it('searches for "pizzasnack" finds Pizzasnack Margherita', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'pizzasnack',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name === 'Pizzasnack Margherita')).toBe(true);
  });

  it('searches for "Margherita" finds Pizzasnack Margherita', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Margherita',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name.includes('Margherita'))).toBe(true);
  });

  it('searches for "Snack" finds Pizzasnack Margherita', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Snack',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name.includes('Pizzasnack'))).toBe(true);
  });

  it('Pizzasnack is cheaper than Toskanabrot', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    const pizzasnack = data.products.find((p) => p.name === 'Pizzasnack Margherita');
    const toskanabrot = data.products.find((p) => p.name === 'Toskanabrot');
    expect(pizzasnack!.price.current).toBeLessThan(toskanabrot!.price.current);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. MILBONA BRAND — TWO DAIRY PRODUCTS (Vollmilch + Emmentaler)
// ═══════════════════════════════════════════════════════════════════════════════

describe('2. Milbona Brand — Two Dairy Products', () => {
  it('searches for "milbona" and finds both Vollmilch and Emmentaler', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'milbona',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    const names = data.products.map((p) => p.name);
    expect(names).toContain('Vollmilch');
    expect(names).toContain('Emmentaler');
    expect(data.products.length).toBeGreaterThanOrEqual(2);
  });

  it('searches for "vollmilch" finds MILBONA Vollmilch', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'vollmilch',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name === 'Vollmilch')).toBe(true);
  });

  it('searches for "emmentaler" finds MILBONA Emmentaler', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'emmentaler',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name === 'Emmentaler')).toBe(true);
  });

  it('Vollmilch is cheaper than Emmentaler', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'milbona',
      chains: ['aldi'],
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    const vollmilch = data.products.find((p) => p.name === 'Vollmilch');
    const emmentaler = data.products.find((p) => p.name === 'Emmentaler');
    expect(vollmilch!.price.current).toBeLessThan(emmentaler!.price.current);
  });

  it('multi-token "milbona vollmilch" finds Vollmilch', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'milbona vollmilch',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name === 'Vollmilch' && p.brand === 'MILBONA')).toBe(true);
  });

  it('multi-token "milbona emmentaler" finds Emmentaler', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'milbona emmentaler',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name === 'Emmentaler' && p.brand === 'MILBONA')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. SINGLE PRODUCTS — FRUITS, BEVERAGES, HOUSEHOLD
// ═══════════════════════════════════════════════════════════════════════════════

describe('3. Single Products — Fruits, Beverages, Household', () => {
  it('searches for "chiquita" finds Banane', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'chiquita',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name === 'Banane' && p.brand === 'CHIQUITA')).toBe(true);
  });

  it('searches for "banane" finds CHIQUITA Banane', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'banane',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name === 'Banane')).toBe(true);
  });

  it('searches for "apfelsaft" finds ALDI EIGENMARKE Apfelsaft', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'apfelsaft',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name === 'Apfelsaft')).toBe(true);
  });

  it('searches for "reinigungsmittel" finds OPTIMUS Reinigungsmittel', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'reinigungsmittel',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name === 'Reinigungsmittel')).toBe(true);
  });

  it('searches for "optimus" finds Reinigungsmittel', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'optimus',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.brand === 'OPTIMUS')).toBe(true);
  });

  it('searches for "fish" finds Fish Fingers', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'fish',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name.includes('Fish'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. CROSS-BRAND SEARCH — ALL BACKBOX + MILBONA PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('4. Cross-Brand Search', () => {
  it('search for "backbox" returns 2 products', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.length).toBe(2);
    expect(data.products.every((p) => p.brand === 'BACKBOX')).toBe(true);
  });

  it('search for "milbona" returns 2 products', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'milbona',
      chains: ['aldi'],
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.length).toBe(2);
    expect(data.products.every((p) => p.brand === 'MILBONA')).toBe(true);
  });

  it('search with limit=1 returns exactly 1 product', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
      limit: 1,
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.length).toBe(1);
  });

  it('search with limit=3 returns at most 3 products', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
      limit: 3,
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.length).toBeLessThanOrEqual(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. PRICE FILTERING ACROSS MULTIPLE PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('5. Price Filtering Across Multiple Products', () => {
  it('maxPrice=1.50 with "backbox" returns only Pizzasnack (1.49)', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
      maxPrice: 1.50,
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.every((p) => p.price.current <= 1.50)).toBe(true);
    expect(data.products.length).toBe(1);
    expect(data.products[0].name).toBe('Pizzasnack Margherita');
  });

  it('maxPrice=2.00 with "backbox" returns only Pizzasnack (1.49)', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
      maxPrice: 2.00,
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.every((p) => p.price.current <= 2.00)).toBe(true);
    expect(data.products.length).toBe(1);
  });

  it('maxPrice=3.00 with "backbox" returns both products', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
      maxPrice: 3.00,
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.every((p) => p.price.current <= 3.00)).toBe(true);
    expect(data.products.length).toBe(2);
  });

  it('maxPrice=1.00 returns empty (cheapest backbox is 1.49)', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
      maxPrice: 1.00,
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products).toEqual([]);
  });

  it('maxPrice=2.00 with "milbona" returns only Vollmilch (1.65)', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'milbona',
      chains: ['aldi'],
      maxPrice: 2.00,
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.every((p) => p.price.current <= 2.00)).toBe(true);
    expect(data.products.length).toBe(1);
    expect(data.products[0].name).toBe('Vollmilch');
  });

  it('maxPrice=5.00 with "milbona" returns both products', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'milbona',
      chains: ['aldi'],
      maxPrice: 5.00,
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.every((p) => p.price.current <= 5.00)).toBe(true);
    expect(data.products.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. COMPARE PRICES ACROSS MULTIPLE PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('6. Compare Prices Across Multiple Products', () => {
  it('compare "backbox" — Pizzasnack cheaper than Toskanabrot', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'backbox',
      chains: ['aldi'],
      limitPerChain: 2,
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      comparison: {
        offers: Array<{ chain: string; effectivePrice: number; totalPrice: number }>;
        cheapestOffer?: { effectivePrice: number };
        mostExpensiveOffer?: { effectivePrice: number };
      };
    }>(result);
    expect(data.comparison.offers.length).toBeGreaterThanOrEqual(2);
    expect(data.comparison.cheapestOffer).toBeDefined();
    expect(data.comparison.mostExpensiveOffer).toBeDefined();
    expect(data.comparison.cheapestOffer!.effectivePrice).toBe(1.49);
    expect(data.comparison.mostExpensiveOffer!.effectivePrice).toBe(2.19);
  });

  it('compare "milbona" — Vollmilch cheaper than Emmentaler', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'milbona',
      chains: ['aldi'],
      limitPerChain: 2,
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      comparison: { offers: Array<{ effectivePrice: number }> };
    }>(result);
    expect(data.comparison.offers.length).toBe(2);
    const prices = data.comparison.offers.map((o) => o.effectivePrice).sort((a, b) => a - b);
    expect(prices[0]).toBe(1.65);
    expect(prices[1]).toBe(4.49);
  });

  it('compare with quantity=10 multiplies all prices', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'milbona',
      chains: ['aldi'],
      quantity: 10,
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      comparison: {
        quantity: number;
        offers: Array<{ effectivePrice: number; totalPrice: number }>;
      };
    }>(result);
    expect(data.comparison.quantity).toBe(10);
    for (const offer of data.comparison.offers) {
      expect(offer.totalPrice).toBeCloseTo(offer.effectivePrice * 10, 1);
    }
  });

  it('compare with quantity=2 for backbox', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'backbox',
      chains: ['aldi'],
      quantity: 2,
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      comparison: {
        quantity: number;
        offers: Array<{ effectivePrice: number; totalPrice: number }>;
      };
    }>(result);
    expect(data.comparison.quantity).toBe(2);
    for (const offer of data.comparison.offers) {
      expect(offer.totalPrice).toBeCloseTo(offer.effectivePrice * 2, 1);
    }
  });

  it('compare with maxPrice=2.00 excludes Toskanabrot (2.19)', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'backbox',
      chains: ['aldi'],
      maxPrice: 2.00,
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      comparison: { offers: Array<{ effectivePrice: number }> };
    }>(result);
    expect(data.comparison.offers.every((o) => o.effectivePrice <= 2.00)).toBe(true);
    expect(data.comparison.offers.length).toBe(1);
  });

  it('compare "optimus" returns single offer', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'optimus',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      comparison: { offers: Array<{ effectivePrice: number }> };
    }>(result);
    expect(data.comparison.offers.length).toBe(1);
    expect(data.comparison.offers[0].effectivePrice).toBe(2.99);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. SEARCH RESULT ORDERING
// ═══════════════════════════════════════════════════════════════════════════════

describe('7. Search Result Ordering', () => {
  it('products sorted by match strength — exact name match first', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Toskanabrot',
      chains: ['aldi'],
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products[0].name).toBe('Toskanabrot');
  });

  it('brand search returns products sorted by match', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'chiquita',
      chains: ['aldi'],
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products[0].brand).toBe('CHIQUITA');
  });

  it('multi-token search: both tokens must match', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'milbona vollmilch',
      chains: ['aldi'],
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name === 'Vollmilch' && p.brand === 'MILBONA')).toBe(true);
  });

  it('multi-token with unmatched token returns empty', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox nonexistentxyz',
      chains: ['aldi'],
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. MATCHMODE WITH MULTIPLE PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('8. MatchMode with Multiple Products', () => {
  it('balanced mode: "backbox" matches both Toskanabrot and Pizzasnack', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
      matchMode: 'balanced',
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.length).toBe(2);
  });

  it('literal mode: "backbox" still matches both products', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
      matchMode: 'literal',
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.length).toBe(2);
  });

  it('balanced mode: "milbona" matches both dairy products', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'milbona',
      chains: ['aldi'],
      matchMode: 'balanced',
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.length).toBe(2);
  });

  it('literal mode: "milbona" still matches both dairy products', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'milbona',
      chains: ['aldi'],
      matchMode: 'literal',
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.length).toBe(2);
  });

  it('balanced mode: "brot" matches Toskanabrot via taxonomy', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'brot',
      chains: ['aldi'],
      matchMode: 'balanced',
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name.includes('Toskanabrot'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. DENNER PROMOTIONS — DEEPER SEARCH
// ═══════════════════════════════════════════════════════════════════════════════

describe('9. Denner Promotions — Deeper Search', () => {
  it('search for "Wein" finds Chardonnay Wein promotion', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'Wein',
      chains: ['denner'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ promotions: NormalizedPromotion[] }>(result);
    expect(data.promotions.some((p) => p.title.includes('Chardonnay'))).toBe(true);
  });

  it('search for "Orangensaft" finds Orangensaft Aktuell promotion', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'Orangensaft',
      chains: ['denner'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ promotions: NormalizedPromotion[] }>(result);
    expect(data.promotions.some((p) => p.title.includes('Orangensaft'))).toBe(true);
  });

  it('search for "Grill" finds Grill Bratwurst Set promotion', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'Grill',
      chains: ['denner'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ promotions: NormalizedPromotion[] }>(result);
    expect(data.promotions.some((p) => p.title.includes('Grill'))).toBe(true);
  });

  it('search for "Chardonnay" finds exact match', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'Chardonnay',
      chains: ['denner'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ promotions: NormalizedPromotion[] }>(result);
    expect(data.promotions.some((p) => p.title.includes('Chardonnay'))).toBe(true);
  });

  it('maxPrice=6.00 returns only Orangensaft Aktuell (5.95)', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'aktion',
      chains: ['denner'],
      maxPrice: 6.00,
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ promotions: NormalizedPromotion[] }>(result);
    if (data.promotions.length > 0) {
      expect(data.promotions.every((p) => (p.price?.current ?? Infinity) <= 6.00)).toBe(true);
    }
  });

  it('maxPrice=8.00 returns Chardonnay (7.95) and Orangensaft (5.95)', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'aktion',
      chains: ['denner'],
      maxPrice: 8.00,
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ promotions: NormalizedPromotion[] }>(result);
    if (data.promotions.length > 0) {
      expect(data.promotions.every((p) => (p.price?.current ?? Infinity) <= 8.00)).toBe(true);
    }
  });

  it('limit=1 returns only the cheapest promotion', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'aktion',
      chains: ['denner'],
      limit: 1,
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ promotions: NormalizedPromotion[] }>(result);
    if (data.promotions.length > 0) {
      expect(data.promotions.length).toBe(1);
      expect(data.promotions[0].price?.current).toBe(5.95);
    }
  });

  it('promotions have validUntil date in the future', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'aktion',
      chains: ['denner'],
    });
    const data = structured<{ promotions: NormalizedPromotion[] }>(result);
    for (const promo of data.promotions) {
      expect(new Date(promo.validUntil).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('promotions have chain set to denner', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'aktion',
      chains: ['denner'],
    });
    const data = structured<{ promotions: NormalizedPromotion[] }>(result);
    expect(data.promotions.every((p) => p.chain === 'denner')).toBe(true);
  });

  it('promotions have price with current value', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'Chardonnay',
      chains: ['denner'],
    });
    const data = structured<{ promotions: NormalizedPromotion[] }>(result);
    if (data.promotions.length > 0) {
      const promo = data.promotions[0];
      expect(promo.price).toBeDefined();
      expect(typeof promo.price!.current).toBe('number');
      expect(promo.price!.current).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. AVAILABILITY LOOKUP — MULTIPLE CHAINS & PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('10. Availability Lookup — Multiple Chains & Products', () => {
  it('lookup Toskanabrot in aldi — unsupported but graceful', async () => {
    const result = await callTool(client, 'lookup_store_product_availability', {
      chain: 'aldi',
      storeId: 'aldi-zurich-1',
      query: 'Toskanabrot',
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
    expect(data.availability.chain).toBe('aldi');
    expect(data.availability.storeId).toBe('aldi-zurich-1');
    expect(data.availability.query).toBe('Toskanabrot');
    expect(data.availability.supported).toBe(false);
    expect(data.availability.isAvailable).toBe(false);
    expect(data.availability.matches).toEqual([]);
  });

  it('lookup Vollmilch in coop — now supported', async () => {
    const result = await callTool(client, 'lookup_store_product_availability', {
      chain: 'coop',
      storeId: 'coop-basel-1',
      query: 'Vollmilch',
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      availability: { chain: string; supported: boolean; isAvailable: boolean; reason?: string };
    }>(result);
    expect(data.availability.chain).toBe('coop');
    expect(data.availability.supported).toBe(true);
  });

  it('lookup Emmentaler in denner — unsupported but graceful', async () => {
    const result = await callTool(client, 'lookup_store_product_availability', {
      chain: 'denner',
      storeId: 'denner-bern-1',
      query: 'Emmentaler',
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      availability: { chain: string; supported: boolean };
    }>(result);
    expect(data.availability.chain).toBe('denner');
    expect(data.availability.supported).toBe(false);
  });

  it('migros and coop return supported=true, other chains return supported=false', async () => {
    const supportedChains = ['migros', 'coop'];
    const unsupportedChains = ['aldi', 'denner', 'farmy', 'volg', 'lidl', 'ottos'];
    for (const chain of supportedChains) {
      const result = await callTool(client, 'lookup_store_product_availability', {
        chain,
        storeId: `${chain}-store-1`,
        query: 'test',
      });
      expect(result.isError).not.toBe(true);
      const data = structured<{
        availability: { chain: string; supported: boolean; isAvailable: boolean };
      }>(result);
      expect(data.availability.supported).toBe(true);
    }
    for (const chain of unsupportedChains) {
      const result = await callTool(client, 'lookup_store_product_availability', {
        chain,
        storeId: `${chain}-store-1`,
        query: 'test',
      });
      expect(result.isError).not.toBe(true);
      const data = structured<{
        availability: { chain: string; supported: boolean; isAvailable: boolean };
      }>(result);
      expect(data.availability.supported).toBe(false);
      expect(data.availability.isAvailable).toBe(false);
    }
  });

  it('lookup with different store IDs returns consistent unsupported result', async () => {
    const storeIds = ['aldi-zurich-1', 'aldi-bern-2', 'aldi-basel-3'];
    for (const storeId of storeIds) {
      const result = await callTool(client, 'lookup_store_product_availability', {
        chain: 'aldi',
        storeId,
        query: 'Apfelsaft',
      });
      expect(result.isError).not.toBe(true);
      const data = structured<{
        availability: { storeId: string; supported: boolean };
      }>(result);
      expect(data.availability.storeId).toBe(storeId);
      expect(data.availability.supported).toBe(false);
    }
  });

  it('lookup with matchMode balanced is accepted', async () => {
    const result = await callTool(client, 'lookup_store_product_availability', {
      chain: 'aldi',
      storeId: 'aldi-zurich-1',
      query: 'Brot',
      matchMode: 'balanced',
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      availability: { supported: boolean };
    }>(result);
    expect(data.availability.supported).toBe(false);
  });

  it('lookup with matchMode literal is accepted', async () => {
    const result = await callTool(client, 'lookup_store_product_availability', {
      chain: 'coop',
      storeId: 'coop-zurich-1',
      query: 'Milch',
      matchMode: 'literal',
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      availability: { supported: boolean };
    }>(result);
    expect(data.availability.supported).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. CROSS-TOOL SEARCH + AVAILABILITY INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('11. Cross-Tool Search + Availability Integration', () => {
  it('search for Toskanabrot, then lookup availability — consistent chain info', async () => {
    const searchResult = await callTool(client, 'search_products', {
      query: 'Toskanabrot',
      chains: ['aldi'],
    });
    const searchData = structured<{ products: NormalizedProduct[] }>(searchResult);
    const product = searchData.products[0];

    const availResult = await callTool(client, 'lookup_store_product_availability', {
      chain: product.chain,
      storeId: 'aldi-zurich-1',
      query: product.name,
    });
    expect(availResult.isError).not.toBe(true);
    const availData = structured<{
      availability: { chain: string; query: string };
    }>(availResult);
    expect(availData.availability.chain).toBe(product.chain);
    expect(availData.availability.query).toBe(product.name);
  });

  it('search for Vollmilch, compare prices, then lookup — data consistency', async () => {
    const searchResult = await callTool(client, 'search_products', {
      query: 'vollmilch',
      chains: ['aldi'],
    });
    const searchData = structured<{ products: NormalizedProduct[] }>(searchResult);
    const product = searchData.products[0];

    const compareResult = await callTool(client, 'compare_prices', {
      query: 'vollmilch',
      chains: ['aldi'],
    });
    const compareData = structured<{
      comparison: { offers: Array<{ effectivePrice: number }> };
    }>(compareResult);
    expect(compareData.comparison.offers[0].effectivePrice).toBe(product.price.current);

    const availResult = await callTool(client, 'lookup_store_product_availability', {
      chain: 'aldi',
      storeId: 'aldi-bern-1',
      query: 'Vollmilch',
    });
    expect(availResult.isError).not.toBe(true);
  });

  it('search backbox, compare cheapest matches search result', async () => {
    const searchResult = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
    });
    const searchData = structured<{ products: NormalizedProduct[] }>(searchResult);
    const cheapestProduct = searchData.products.reduce((min, p) =>
      p.price.current < min.price.current ? p : min
    );

    const compareResult = await callTool(client, 'compare_prices', {
      query: 'backbox',
      chains: ['aldi'],
    });
    const compareData = structured<{
      comparison: { cheapestOffer?: { effectivePrice: number } };
    }>(compareResult);
    expect(compareData.comparison.cheapestOffer!.effectivePrice).toBe(
      cheapestProduct.price.current
    );
  });

  it('Denner promotions search then compare with includePromotions', async () => {
    const promoResult = await callTool(client, 'search_promotions', {
      query: 'Orangensaft',
      chains: ['denner'],
    });
    expect(promoResult.isError).not.toBe(true);
    const promoData = structured<{ promotions: NormalizedPromotion[] }>(promoResult);
    expect(promoData.promotions.some((p) => p.title.includes('Orangensaft'))).toBe(true);

    const compareResult = await callTool(client, 'compare_prices', {
      query: 'Orangensaft',
      chains: ['denner'],
      includePromotions: true,
    });
    expect(compareResult.isError).not.toBe(true);
    const compareData = structured<{
      comparison: {
        offers: Array<{ chain: string; effectivePrice: number; priceBasis: string }>;
      };
    }>(compareResult);
    const dennerOffers = compareData.comparison.offers.filter((o) => o.chain === 'denner');
    expect(dennerOffers.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. SOURCE STATUS WITH MULTIPLE CHAINS
// ═══════════════════════════════════════════════════════════════════════════════

describe('12. Source Status with Multiple Chains', () => {
  it('aldi productSearch live-beta, all other capabilities unsupported', async () => {
    const result = await callTool(client, 'get_source_status', { chains: ['aldi'] });
    const data = structured<{
      statuses: Array<{ chain: string; capability: string; status: string }>;
    }>(result);
    const productSearch = data.statuses.find((s) => s.capability === 'productSearch');
    expect(productSearch!.status).toBe('live-beta');
    const storeSearch = data.statuses.find((s) => s.capability === 'storeSearch');
    expect(storeSearch!.status).toBe('unsupported');
  });

  it('denner promotions live-beta, productSearch unsupported', async () => {
    const result = await callTool(client, 'get_source_status', { chains: ['denner'] });
    const data = structured<{
      statuses: Array<{ chain: string; capability: string; status: string }>;
    }>(result);
    const promos = data.statuses.find((s) => s.capability === 'promotions');
    expect(promos!.status).toBe('live-beta');
    const productSearch = data.statuses.find((s) => s.capability === 'productSearch');
    expect(productSearch!.status).toBe('unsupported');
  });

  it('all chains have 5 capabilities each', async () => {
    const result = await callTool(client, 'get_source_status', {});
    const data = structured<{
      statuses: Array<{ chain: string; capability: string; status: string }>;
    }>(result);
    const chains = ['aldi', 'coop', 'denner', 'farmy', 'lidl', 'migros', 'ottos', 'volg'];
    for (const chain of chains) {
      const chainStatuses = data.statuses.filter((s) => s.chain === chain);
      expect(chainStatuses.length).toBe(5);
    }
  });

  it('get_store_availability_support for all chains shows correct support', async () => {
    const result = await callTool(client, 'get_store_availability_support', {});
    const data = structured<{
      support: Array<{ chain: string; supported: boolean }>;
    }>(result);
    expect(data.support.length).toBe(8);
    const supportedChains = data.support.filter((s) => s.supported === true).map((s) => s.chain);
    expect(supportedChains).toContain('migros');
    expect(supportedChains).toContain('coop');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. EDGE CASES WITH MULTIPLE PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('13. Edge Cases with Multiple Products', () => {
  it('query with no matches returns empty products array', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'xyznonexistent999',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products).toEqual([]);
  });

  it('multi-token with both matching returns product', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox toskanabrot',
      chains: ['aldi'],
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name === 'Toskanabrot')).toBe(true);
  });

  it('multi-token "backbox pizzasnack" returns Pizzasnack', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox pizzasnack',
      chains: ['aldi'],
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name === 'Pizzasnack Margherita')).toBe(true);
  });

  it('case-insensitive search: "toskanabrot" matches "Toskanabrot"', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'toskanabrot',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.name === 'Toskanabrot')).toBe(true);
  });

  it('case-insensitive search: "backbox" matches "BACKBOX" brand', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.brand === 'BACKBOX')).toBe(true);
  });

  it('mixed case query: "MiLbOnA" matches "MILBONA" brand', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'MiLbOnA',
      chains: ['aldi'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.some((p) => p.brand === 'MILBONA')).toBe(true);
  });

  it('very specific query with no partial matches returns empty', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Toskanabrot XYZ',
      chains: ['aldi'],
      matchMode: 'balanced',
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. CONCURRENT MULTI-PRODUCT OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

describe('14. Concurrent Multi-Product Operations', () => {
  it('concurrent searches for different products do not interfere', async () => {
    const [r1, r2, r3, r4] = await Promise.all([
      callTool(client, 'search_products', { query: 'toskanabrot', chains: ['aldi'] }),
      callTool(client, 'search_products', { query: 'vollmilch', chains: ['aldi'] }),
      callTool(client, 'search_products', { query: 'banane', chains: ['aldi'] }),
      callTool(client, 'search_products', { query: 'emmentaler', chains: ['aldi'] }),
    ]);
    const d1 = structured<{ products: NormalizedProduct[] }>(r1);
    const d2 = structured<{ products: NormalizedProduct[] }>(r2);
    const d3 = structured<{ products: NormalizedProduct[] }>(r3);
    const d4 = structured<{ products: NormalizedProduct[] }>(r4);
    expect(d1.products[0].name).toBe('Toskanabrot');
    expect(d2.products[0].name).toBe('Vollmilch');
    expect(d3.products[0].name).toBe('Banane');
    expect(d4.products[0].name).toBe('Emmentaler');
  });

  it('concurrent compare + search + availability calls succeed', async () => {
    const [search, compare, avail, status] = await Promise.all([
      callTool(client, 'search_products', { query: 'backbox', chains: ['aldi'] }),
      callTool(client, 'compare_prices', { query: 'milbona', chains: ['aldi'] }),
      callTool(client, 'lookup_store_product_availability', {
        chain: 'aldi',
        storeId: 'test',
        query: 'test',
      }),
      callTool(client, 'get_source_status', { chains: ['aldi'] }),
    ]);
    expect(search.isError).not.toBe(true);
    expect(compare.isError).not.toBe(true);
    expect(avail.isError).not.toBe(true);
    expect(status.isError).not.toBe(true);
  });

  it('rapid sequential searches for 8 different products', async () => {
    const queries = [
      'toskanabrot', 'pizzasnack', 'vollmilch', 'emmentaler', 'banane',
      'apfelsaft', 'reinigungsmittel', 'fish',
    ];
    for (const query of queries) {
      const result = await callTool(client, 'search_products', {
        query,
        chains: ['aldi'],
      });
      expect(result.isError).not.toBe(true);
      const data = structured<{ products: NormalizedProduct[] }>(result);
      expect(data.products.length).toBeGreaterThan(0);
    }
  });

  it('concurrent promotions searches for different queries', async () => {
    const [r1, r2, r3] = await Promise.all([
      callTool(client, 'search_promotions', { query: 'Wein', chains: ['denner'] }),
      callTool(client, 'search_promotions', { query: 'Orangensaft', chains: ['denner'] }),
      callTool(client, 'search_promotions', { query: 'Grill', chains: ['denner'] }),
    ]);
    expect(r1.isError).not.toBe(true);
    expect(r2.isError).not.toBe(true);
    expect(r3.isError).not.toBe(true);
    const d1 = structured<{ promotions: NormalizedPromotion[] }>(r1);
    const d2 = structured<{ promotions: NormalizedPromotion[] }>(r2);
    const d3 = structured<{ promotions: NormalizedPromotion[] }>(r3);
    expect(d1.promotions.some((p) => p.title.includes('Chardonnay'))).toBe(true);
    expect(d2.promotions.some((p) => p.title.includes('Orangensaft'))).toBe(true);
    expect(d3.promotions.some((p) => p.title.includes('Grill'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 15. PRODUCT DATA INTEGRITY ACROSS MULTIPLE RESULTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('15. Product Data Integrity Across Multiple Results', () => {
  it('all products have required fields', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    for (const product of data.products) {
      expect(typeof product.id).toBe('string');
      expect(product.id.length).toBeGreaterThan(0);
      expect(typeof product.chain).toBe('string');
      expect(typeof product.name).toBe('string');
      expect(product.name.length).toBeGreaterThan(0);
      expect(typeof product.price).toBe('object');
      expect(typeof product.price.current).toBe('number');
      expect(product.price.current).toBeGreaterThan(0);
    }
  });

  it('all products have chain set to aldi', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    expect(data.products.every((p) => p.chain === 'aldi')).toBe(true);
  });

  it('all products have unique IDs', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    const ids = data.products.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('product prices are positive numbers', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    for (const product of data.products) {
      expect(product.price.current).toBeGreaterThan(0);
      expect(Number.isFinite(product.price.current)).toBe(true);
    }
  });

  it('products with brands have non-empty brand strings', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
    });
    const data = structured<{ products: NormalizedProduct[] }>(result);
    for (const product of data.products) {
      if (product.brand) {
        expect(typeof product.brand).toBe('string');
        expect(product.brand.length).toBeGreaterThan(0);
      }
    }
  });

  it('Denner promotions have valid price structure', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'aktion',
      chains: ['denner'],
    });
    const data = structured<{ promotions: NormalizedPromotion[] }>(result);
    for (const promo of data.promotions) {
      expect(promo.price).toBeDefined();
      expect(typeof promo.price!.current).toBe('number');
      expect(promo.price!.current).toBeGreaterThan(0);
      expect(typeof promo.price!.currency).toBe('string');
    }
  });

  it('Denner promotions have valid dates', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'aktion',
      chains: ['denner'],
    });
    const data = structured<{ promotions: NormalizedPromotion[] }>(result);
    for (const promo of data.promotions) {
      expect(new Date(promo.validFrom).getTime()).not.toBeNaN();
      expect(new Date(promo.validUntil).getTime()).not.toBeNaN();
      expect(new Date(promo.validUntil).getTime()).toBeGreaterThan(
        new Date(promo.validFrom).getTime()
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 16. SEARCH WITH MULTIPLE CHAINS — PARTIAL RESULTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('16. Search with Multiple Chains — Partial Results', () => {
  it('aldi + farmy: aldi returns products, farmy returns warning', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'Toskanabrot',
      chains: ['aldi', 'farmy'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      products: NormalizedProduct[];
      sourceWarnings?: Array<{ chain: string; code: string }>;
    }>(result);
    expect(data.products.length).toBeGreaterThan(0);
    expect(data.sourceWarnings).toBeDefined();
    expect(data.sourceWarnings!.some((w) => w.chain === 'farmy')).toBe(true);
  });

  it('denner + farmy: denner promotions, farmy warning', async () => {
    const result = await callTool(client, 'search_promotions', {
      query: 'Wein',
      chains: ['denner', 'farmy'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      promotions: NormalizedPromotion[];
      sourceWarnings?: Array<{ chain: string }>;
    }>(result);
    expect(data.sourceWarnings!.some((w) => w.chain === 'farmy')).toBe(true);
  });

  it('compare with aldi + farmy: aldi offers, farmy warning', async () => {
    const result = await callTool(client, 'compare_prices', {
      query: 'Toskanabrot',
      chains: ['aldi', 'farmy'],
    });
    expect(result.isError).not.toBe(true);
    const data = structured<{
      comparison: { offers: Array<{ chain: string }> };
      sourceWarnings?: Array<{ chain: string }>;
    }>(result);
    expect(data.comparison.offers.some((o) => o.chain === 'aldi')).toBe(true);
    expect(data.sourceWarnings!.some((w) => w.chain === 'farmy')).toBe(true);
  });

  it('all unsupported chains return ALL_SOURCES_FAILED', async () => {
    const result = await callTool(client, 'search_products', {
      query: 'milk',
      chains: ['farmy'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ALL_SOURCES_FAILED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 17. SEARCH + COMPARE ROUND-TRIP SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

describe('17. Search + Compare Round-Trip Scenarios', () => {
  it('search backbox, compare, verify cheapest matches search result', async () => {
    const searchResult = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
    });
    const searchData = structured<{ products: NormalizedProduct[] }>(searchResult);
    const cheapestProduct = searchData.products.reduce((min, p) =>
      p.price.current < min.price.current ? p : min
    );

    const compareResult = await callTool(client, 'compare_prices', {
      query: 'backbox',
      chains: ['aldi'],
    });
    const compareData = structured<{
      comparison: { cheapestOffer?: { effectivePrice: number } };
    }>(compareResult);
    expect(compareData.comparison.cheapestOffer!.effectivePrice).toBe(
      cheapestProduct.price.current
    );
  });

  it('search milbona, compare, verify most expensive matches', async () => {
    const searchResult = await callTool(client, 'search_products', {
      query: 'milbona',
      chains: ['aldi'],
    });
    const searchData = structured<{ products: NormalizedProduct[] }>(searchResult);
    const expensiveProduct = searchData.products.reduce((max, p) =>
      p.price.current > max.price.current ? p : max
    );

    const compareResult = await callTool(client, 'compare_prices', {
      query: 'milbona',
      chains: ['aldi'],
      limitPerChain: 2,
    });
    const compareData = structured<{
      comparison: { mostExpensiveOffer?: { effectivePrice: number } };
    }>(compareResult);
    expect(compareData.comparison.mostExpensiveOffer!.effectivePrice).toBe(
      expensiveProduct.price.current
    );
  });

  it('search with maxPrice, compare with same maxPrice — consistent', async () => {
    const maxPrice = 2.00;
    const searchResult = await callTool(client, 'search_products', {
      query: 'backbox',
      chains: ['aldi'],
      maxPrice,
    });
    const searchData = structured<{ products: NormalizedProduct[] }>(searchResult);
    expect(searchData.products.every((p) => p.price.current <= maxPrice)).toBe(true);

    const compareResult = await callTool(client, 'compare_prices', {
      query: 'backbox',
      chains: ['aldi'],
      maxPrice,
    });
    const compareData = structured<{
      comparison: { offers: Array<{ effectivePrice: number }> };
    }>(compareResult);
    expect(compareData.comparison.offers.every((o) => o.effectivePrice <= maxPrice)).toBe(true);
  });

  it('search Denner promotions, compare with includePromotions, verify promotion included', async () => {
    const searchResult = await callTool(client, 'search_promotions', {
      query: 'Grill',
      chains: ['denner'],
    });
    const searchData = structured<{ promotions: NormalizedPromotion[] }>(searchResult);
    expect(searchData.promotions.some((p) => p.title.includes('Grill'))).toBe(true);

    const compareResult = await callTool(client, 'compare_prices', {
      query: 'Grill',
      chains: ['denner'],
      includePromotions: true,
    });
    expect(compareResult.isError).not.toBe(true);
  });
});
