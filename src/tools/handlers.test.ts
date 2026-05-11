import { describe, expect, it } from 'vitest';

import { createDefaultAdapters } from '../adapters/index.js';
import { PriceComparisonService } from '../services/priceComparisonService.js';
import { SearchService } from '../services/searchService.js';
import { executeToolCall, listTools } from './handlers.js';

const searchService = new SearchService(createDefaultAdapters());
const priceComparisonService = new PriceComparisonService(createDefaultAdapters());
const dependencies = { searchService, priceComparisonService };

describe('tool handlers', () => {
  it('lists all V1 tools with explicit schemas', () => {
    const result = listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual([
      'search_products',
      'find_stores',
      'compare_prices',
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
      { name: 'search_products', arguments: { query: 'pasta', limit: 2 } },
      dependencies,
    );

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { products: unknown[] };
    expect(structured.products).toHaveLength(2);
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
});
