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

function createLoopbackTransportPair(): { clientTransport: LoopbackTransport; serverTransport: LoopbackTransport } {
  const clientTransport = new LoopbackTransport();
  const serverTransport = new LoopbackTransport();
  clientTransport.attachPeer(serverTransport);
  serverTransport.attachPeer(clientTransport);

  return { clientTransport, serverTransport };
}

describe('MCP server integration', () => {
  it('lists all registered tools over MCP transport', async () => {
    const server = await createServer({ adapterOptions: { dataMode: 'legacy-static' } });
    const client = new Client({ name: 'swiss-shopping-mcp-tests', version: '1.0.0' });
    const { clientTransport, serverTransport } = createLoopbackTransportPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'search_products',
      'find_stores',
      'compare_prices',
      'get_store_availability_support',
      'lookup_store_product_availability',
    ]);

    await client.close();
    await server.close();
  });

  it('retrieves search/store/compare/availability results end-to-end via MCP', async () => {
    const server = await createServer({ adapterOptions: { dataMode: 'legacy-static' } });
    const client = new Client({ name: 'swiss-shopping-mcp-tests', version: '1.0.0' });
    const { clientTransport, serverTransport } = createLoopbackTransportPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const searchResult = await client.callTool({
      name: 'search_products',
      arguments: { query: 'milk', limit: 1 },
    });
    expect(searchResult.isError).not.toBe(true);
    expect((searchResult.structuredContent as { products: unknown[] }).products).toHaveLength(1);

    const storeResult = await client.callTool({
      name: 'find_stores',
      arguments: { location: 'zürich', limit: 2 },
    });
    expect(storeResult.isError).not.toBe(true);
    expect((storeResult.structuredContent as { stores: unknown[] }).stores.length).toBeGreaterThan(0);

    const compareResult = await client.callTool({
      name: 'compare_prices',
      arguments: { query: 'milk', quantity: 1 },
    });
    expect(compareResult.isError).not.toBe(true);
    const comparison = (compareResult.structuredContent as { comparison: { cheapestOffer?: { chain: string } } })
      .comparison;
    expect(comparison.cheapestOffer?.chain).toBe('migros');

    const pastaResult = await client.callTool({
      name: 'search_products',
      arguments: { query: 'pasta' },
    });
    expect(pastaResult.isError).not.toBe(true);
    expect((pastaResult.structuredContent as { products: Array<{ id: string }> }).products.map((product) => product.id))
      .toEqual(['migros-pasta-500g', 'ottos-pasta-500g', 'denner-pasta-500g']);

    const unitCompareResult = await client.callTool({
      name: 'compare_prices',
      arguments: { query: 'pasta', comparisonBasis: 'unitPrice' },
    });
    expect(unitCompareResult.isError).not.toBe(true);
    const unitComparison = unitCompareResult.structuredContent as {
      comparison: { cheapestOffer?: { product: { id: string } }; comparisonUnit?: string };
    };
    expect(unitComparison.comparison.cheapestOffer?.product.id).toBe('ottos-pasta-500g');
    expect(unitComparison.comparison.comparisonUnit).toBe('kg');

    const availabilitySupportResult = await client.callTool({
      name: 'get_store_availability_support',
      arguments: { chains: ['migros', 'coop'] },
    });
    expect(availabilitySupportResult.isError).not.toBe(true);
    expect((availabilitySupportResult.structuredContent as { support: Array<{ chain: string }> }).support).toEqual([
      { chain: 'coop', supported: false, reason: expect.any(String) },
      { chain: 'migros', supported: true },
    ]);

    const availabilityResult = await client.callTool({
      name: 'lookup_store_product_availability',
      arguments: { chain: 'migros', storeId: 'migros-zurich-1', query: 'milk' },
    });
    expect(availabilityResult.isError).not.toBe(true);
    const availability = availabilityResult.structuredContent as {
      availability: { chain: string; supported: boolean; isAvailable: boolean };
    };
    expect(availability.availability.chain).toBe('migros');
    expect(availability.availability.supported).toBe(true);
    expect(availability.availability.isAvailable).toBe(true);

    await client.close();
    await server.close();
  });

  it('returns explicit MCP errors for invalid and unknown tool requests', async () => {
    const server = await createServer({ adapterOptions: { dataMode: 'legacy-static' } });
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
});
