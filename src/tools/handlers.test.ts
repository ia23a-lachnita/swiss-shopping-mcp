import { describe, expect, it } from 'vitest';

import { createDefaultAdapters } from '../adapters/index.js';
import { SourceWarningCode } from '../adapters/types.js';
import { PriceComparisonService } from '../services/priceComparisonService.js';
import { SearchService } from '../services/searchService.js';
import { executeToolCall, listTools } from './handlers.js';

const searchService = new SearchService(createDefaultAdapters({ dataMode: 'legacy-static' }));
const priceComparisonService = new PriceComparisonService(createDefaultAdapters({ dataMode: 'legacy-static' }));
const dependencies = { searchService, priceComparisonService };

const sourceWarning = {
  chain: 'coop',
  code: SourceWarningCode.SourceUnavailable,
  message: 'coop source failed.',
  observedAt: '2026-05-18T10:00:00.000Z',
} as const;

describe('tool handlers', () => {
  it('lists all V1 tools with explicit schemas', () => {
    const result = listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual([
      'search_products',
      'find_stores',
      'compare_prices',
      'get_store_availability_support',
      'lookup_store_product_availability',
    ]);
  });

  it('returns error for unknown tool', async () => {
    const result = await executeToolCall({ name: 'unknown_tool', arguments: {} }, dependencies);
    expect(result.isError).toBe(true);
  });

  it('returns error for invalid tool arguments', async () => {
    const result = await executeToolCall({ name: 'search_products', arguments: {} }, dependencies);
    expect(result.isError).toBe(true);
  });

  it('executes search_products successfully', async () => {
    const result = await executeToolCall(
      { name: 'search_products', arguments: { query: 'pantry', limit: 2 } },
      dependencies,
    );

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { products: unknown[] };
    expect(structured.products).toHaveLength(2);
  });

  it('includes source warnings from search_products metadata', async () => {
    const customDependencies = {
      searchService: {
        async searchProducts() {
          return {
            ok: true,
            data: [],
            metadata: { sourceWarnings: [sourceWarning] },
          } as const;
        },
      } as unknown as SearchService,
      priceComparisonService,
    };

    const result = await executeToolCall(
      { name: 'search_products', arguments: { query: 'milk' } },
      customDependencies,
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      products: [],
      sourceWarnings: [sourceWarning],
    });
  });

  it('executes find_stores successfully', async () => {
    const result = await executeToolCall(
      { name: 'find_stores', arguments: { location: 'zürich' } },
      dependencies,
    );

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { stores: unknown[] };
    expect(structured.stores.length).toBeGreaterThan(0);
  });

  it('includes source warnings from find_stores metadata', async () => {
    const customDependencies = {
      searchService: {
        async findStores() {
          return {
            ok: true,
            data: [],
            metadata: { sourceWarnings: [sourceWarning] },
          } as const;
        },
      } as unknown as SearchService,
      priceComparisonService,
    };

    const result = await executeToolCall(
      { name: 'find_stores', arguments: { location: 'zürich' } },
      customDependencies,
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      stores: [],
      sourceWarnings: [sourceWarning],
    });
  });

  it('executes compare_prices successfully', async () => {
    const result = await executeToolCall(
      { name: 'compare_prices', arguments: { query: 'milk', quantity: 1 } },
      dependencies,
    );

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      comparison: { offers: unknown[]; cheapestOffer?: { chain: string } };
    };
    expect(structured.comparison.offers.length).toBeGreaterThan(0);
    expect(structured.comparison.cheapestOffer?.chain).toBe('migros');
  });

  it('includes source warnings from compare_prices metadata', async () => {
    const customDependencies = {
      searchService,
      priceComparisonService: {
        async comparePrices() {
          return {
            ok: true,
            data: {
              query: 'milk',
              quantity: 1,
              offers: [],
              comparisonBasis: 'packPrice',
            },
            metadata: { sourceWarnings: [sourceWarning] },
          } as const;
        },
      } as unknown as PriceComparisonService,
    };

    const result = await executeToolCall(
      { name: 'compare_prices', arguments: { query: 'milk' } },
      customDependencies,
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      comparison: { query: 'milk', offers: [] },
      sourceWarnings: [sourceWarning],
    });
  });

  it('executes compare_prices with comparisonBasis unitPrice successfully', async () => {
    const result = await executeToolCall(
      {
        name: 'compare_prices',
        arguments: { query: 'pasta', comparisonBasis: 'unitPrice', chains: ['migros', 'denner'] },
      },
      dependencies,
    );

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      comparison: { cheapestOffer?: { product: { id: string } } };
    };
    // denner penne (2.40/kg) is cheaper than migros pasta (3.40/kg)
    expect(structured.comparison.cheapestOffer?.product.id).toBe('denner-pasta-500g');
  });

  it('executes search_products with matchMode successfully', async () => {
    const result = await executeToolCall(
      { name: 'search_products', arguments: { query: 'pasta', matchMode: 'balanced', chains: ['ottos'] } },
      dependencies,
    );

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { products: Array<{ name: string }> };
    // ottos has Spaghetti which is a balanced match for pasta
    expect(structured.products).toHaveLength(1);
    expect(structured.products[0].name).toBe('Spaghetti');

    const literalResult = await executeToolCall(
      { name: 'search_products', arguments: { query: 'pasta', matchMode: 'literal', chains: ['ottos'] } },
      dependencies,
    );
    expect(literalResult.isError).not.toBe(true);
    const literalStructured = literalResult.structuredContent as { products: unknown[] };
    expect(literalStructured.products).toHaveLength(0);
  });

  it('executes get_store_availability_support successfully', async () => {
    const result = await executeToolCall(
      { name: 'get_store_availability_support', arguments: { chains: ['migros', 'coop'] } },
      dependencies,
    );

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { support: Array<{ chain: string; supported: boolean }> };
    expect(structured.support).toEqual([
      { chain: 'coop', supported: false, reason: expect.any(String) },
      { chain: 'migros', supported: true },
    ]);
  });

  it('executes lookup_store_product_availability successfully', async () => {
    const result = await executeToolCall(
      {
        name: 'lookup_store_product_availability',
        arguments: { chain: 'migros', storeId: 'migros-zurich-1', query: 'milk' },
      },
      dependencies,
    );

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      availability: { chain: string; supported: boolean; isAvailable: boolean };
    };
    expect(structured.availability.chain).toBe('migros');
    expect(structured.availability.supported).toBe(true);
    expect(structured.availability.isAvailable).toBe(true);
  });

  it('returns unsupported availability response for chains without store stock support', async () => {
    const result = await executeToolCall(
      {
        name: 'lookup_store_product_availability',
        arguments: { chain: 'coop', storeId: 'coop-basel-1', query: 'milk' },
      },
      dependencies,
    );

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      availability: { supported: boolean; isAvailable: boolean; reason?: string };
    };
    expect(structured.availability.supported).toBe(false);
    expect(structured.availability.isAvailable).toBe(false);
    expect(structured.availability.reason).toBeTruthy();
  });
});
