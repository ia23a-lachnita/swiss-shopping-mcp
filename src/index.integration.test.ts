import { readFile } from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MessageExtraInfo, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';

import { createServer } from './index.js';

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

const PRODUCT_URL =
  'https://www.aldi-suisse.ch/de/produkt/backbox-toskanabrot-000000000000101698';
const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url>
    <loc>${PRODUCT_URL}</loc>
    <lastmod>2026-05-18</lastmod>
  </url>
</urlset>`;

async function createFakeFetch(): Promise<typeof fetch> {
  const aldiProductHtml = await readFile(
    new URL(
      '../fixtures/live-sources/aldi/product-toskanabrot.sample.html',
      import.meta.url
    ),
    'utf8'
  );
  const dennerHtml = await readFile(
    new URL(
      '../fixtures/live-sources/denner/current-actions.sample.html',
      import.meta.url
    ),
    'utf8'
  );

  return async (input: string | URL | Request): Promise<Response> => {
    const url = input.toString();
    if (url.endsWith('/sitemap_products.xml')) {
      return new Response(SITEMAP_XML, {
        status: 200,
        headers: { 'content-type': 'text/xml' },
      });
    }
    if (url === PRODUCT_URL) {
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

describe('MCP server integration', () => {
  it('lists all registered tools over MCP transport', async () => {
    const fakeFetch = await createFakeFetch();
    const server = await createServer({
      adapterOptions: { cacheDirectory: 'test-cache', fetchImpl: fakeFetch },
    });
    const client = new Client({ name: 'swiss-shopping-mcp-tests', version: '1.0.0' });
    const { clientTransport, serverTransport } = createLoopbackTransportPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'search_products',
      'search_promotions',
      'find_stores',
      'compare_prices',
      'get_store_availability_support',
      'lookup_store_product_availability',
      'get_source_status',
    ]);

    await client.close();
    await server.close();
  });

  it('returns explicit MCP errors for invalid and unknown tool requests', async () => {
    const fakeFetch = await createFakeFetch();
    const server = await createServer({
      adapterOptions: { cacheDirectory: 'test-cache', fetchImpl: fakeFetch },
    });
    const client = new Client({ name: 'swiss-shopping-mcp-tests', version: '1.0.0' });
    const { clientTransport, serverTransport } = createLoopbackTransportPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const invalidArgumentsResult = await client.callTool({
      name: 'search_products',
      arguments: { query: 'milk', unexpected: true },
    });
    expect(invalidArgumentsResult.isError).toBe(true);
    expect(invalidArgumentsResult.content[0].type).toBe('text');
    if (invalidArgumentsResult.content[0].type === 'text') {
      expect(invalidArgumentsResult.content[0].text).toContain('INVALID_ARGUMENTS');
    }

    const unknownToolResult = await client.callTool({
      name: 'unknown_tool',
      arguments: {},
    });
    expect(unknownToolResult.isError).toBe(true);
    expect(unknownToolResult.content[0].type).toBe('text');
    if (unknownToolResult.content[0].type === 'text') {
      expect(unknownToolResult.content[0].text).toContain('UNKNOWN_TOOL');
    }

    await client.close();
    await server.close();
  });

  it('returns source status for all chains via get_source_status', async () => {
    const fakeFetch = await createFakeFetch();
    const server = await createServer({
      adapterOptions: { cacheDirectory: 'test-cache', fetchImpl: fakeFetch },
    });
    const client = new Client({ name: 'swiss-shopping-mcp-tests', version: '1.0.0' });
    const { clientTransport, serverTransport } = createLoopbackTransportPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({ name: 'get_source_status', arguments: {} });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      statuses: Array<{ chain: string; capability: string; status: string }>;
    };
    expect(structured.statuses.length).toBeGreaterThan(0);

    const chains = new Set(structured.statuses.map((s) => s.chain));
    expect(chains.has('aldi')).toBe(true);
    expect(chains.has('denner')).toBe(true);
    expect(chains.has('migros')).toBe(true);
    expect(chains.has('coop')).toBe(true);

    await client.close();
    await server.close();
  });

  it('does not use StaticChainAdapter in default runtime', async () => {
    const fakeFetch = await createFakeFetch();
    const server = await createServer({
      adapterOptions: { cacheDirectory: 'test-cache', fetchImpl: fakeFetch },
    });

    const client = new Client({ name: 'swiss-shopping-mcp-tests', version: '1.0.0' });
    const { clientTransport, serverTransport } = createLoopbackTransportPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: 'get_source_status',
      arguments: { chains: ['migros'] },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      statuses: Array<{ chain: string; status: string }>;
    };
    expect(structured.statuses.every((s) => s.status !== 'static-v1')).toBe(true);

    await client.close();
    await server.close();
  });
});
