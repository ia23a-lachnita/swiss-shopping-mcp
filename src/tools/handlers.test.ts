import { describe, expect, it } from 'vitest';

import { UnsupportedChainAdapter } from '../adapters/unsupportedAdapter.js';
import {
  Chain,
  ChainAdapter,
  NormalizedProduct,
  NormalizedPromotion,
  NormalizedStore,
  ProductSearchFilters,
  PromotionSearchFilters,
  Result,
  SourceWarningCode,
  StoreAvailabilitySupport,
  StoreProductAvailabilityFilters,
  StoreProductAvailabilityResult,
  StoreSearchFilters,
} from '../adapters/types.js';
import { PriceComparisonService } from '../services/priceComparisonService.js';
import { SearchService } from '../services/searchService.js';
import { executeToolCall, listTools } from './handlers.js';

function stubAdapter(
  chain: Chain,
  products: NormalizedProduct[] = [],
  promotions: NormalizedPromotion[] = [],
  stores: NormalizedStore[] = []
): ChainAdapter {
  return {
    chain,
    async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
      return { ok: true, data: products.slice(0, filters.limit) };
    },
    async searchPromotions(
      filters: PromotionSearchFilters
    ): Promise<Result<NormalizedPromotion[]>> {
      return { ok: true, data: promotions.slice(0, filters.limit) };
    },
    async findStores(filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
      return { ok: true, data: stores.slice(0, filters.limit) };
    },
    getStoreAvailabilitySupport(): StoreAvailabilitySupport {
      return { chain, supported: false };
    },
    async lookupStoreProductAvailability(
      filters: StoreProductAvailabilityFilters
    ): Promise<Result<StoreProductAvailabilityResult>> {
      return {
        ok: true,
        data: {
          chain,
          storeId: filters.storeId,
          query: filters.query,
          supported: false,
          matches: [],
          isAvailable: false,
        },
      };
    },
  };
}

function testProduct(id: string, chain: Chain, price = 1): NormalizedProduct {
  return { id, chain, name: id, price: { current: price } };
}

function testStore(id: string, chain: Chain): NormalizedStore {
  return {
    id,
    chain,
    name: id,
    address: 'Teststrasse 1, 8000 Zürich',
    location: { latitude: 47.3769, longitude: 8.5417 },
  };
}

const aldiAdapter = stubAdapter(
  'aldi',
  [testProduct('aldi-milk', 'aldi', 1.5), testProduct('aldi-bread', 'aldi', 2)],
  [],
  [testStore('aldi-zurich', 'aldi')]
);
const coopAdapter = new UnsupportedChainAdapter('coop');

const searchService = new SearchService([aldiAdapter, coopAdapter]);
const priceComparisonService = new PriceComparisonService([aldiAdapter, coopAdapter]);
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
      'search_promotions',
      'find_stores',
      'compare_prices',
      'get_store_availability_support',
      'lookup_store_product_availability',
      'get_source_status',
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
      { name: 'search_products', arguments: { query: 'milk', limit: 2 } },
      dependencies
    );

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { products: unknown[] };
    expect(structured.products.length).toBeGreaterThan(0);
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
      customDependencies
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
      dependencies
    );

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { stores: unknown[] };
    expect(structured.stores.length).toBeGreaterThanOrEqual(0);
  });

  it('executes search_promotions successfully', async () => {
    const customDependencies = {
      searchService: {
        async searchPromotions() {
          return {
            ok: true,
            data: [
              {
                id: 'denner-orange-juice-promo',
                chain: 'denner',
                title: 'Orange Juice',
                price: { current: 2 },
                validFrom: new Date('2026-05-19T00:00:00.000Z'),
                validUntil: new Date('2026-05-20T23:59:59.999Z'),
              },
            ],
            metadata: { sourceWarnings: [sourceWarning] },
          } as const;
        },
      } as unknown as SearchService,
      priceComparisonService,
    };

    const result = await executeToolCall(
      { name: 'search_promotions', arguments: { query: 'orange', chains: ['denner'] } },
      customDependencies
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      promotions: [{ id: 'denner-orange-juice-promo' }],
      sourceWarnings: [sourceWarning],
    });
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
      customDependencies
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
      dependencies
    );

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      comparison: { offers: unknown[] };
    };
    expect(structured.comparison.offers.length).toBeGreaterThanOrEqual(0);
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
      customDependencies
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      comparison: { query: 'milk', offers: [] },
      sourceWarnings: [sourceWarning],
    });
  });

  it('executes get_store_availability_support successfully', async () => {
    const result = await executeToolCall(
      { name: 'get_store_availability_support', arguments: { chains: ['aldi', 'coop'] } },
      dependencies
    );

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      support: Array<{ chain: string; supported: boolean }>;
    };
    expect(structured.support.every((entry) => !entry.supported)).toBe(true);
  });

  it('executes lookup_store_product_availability for an unsupported chain', async () => {
    const result = await executeToolCall(
      {
        name: 'lookup_store_product_availability',
        arguments: { chain: 'coop', storeId: 'coop-basel-1', query: 'milk' },
      },
      dependencies
    );

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      availability: { chain: string; supported: boolean; isAvailable: boolean; reason?: string };
    };
    expect(structured.availability.chain).toBe('coop');
    expect(structured.availability.supported).toBe(false);
    expect(structured.availability.isAvailable).toBe(false);
    expect(structured.availability.reason).toBeTruthy();
  });

  it('executes get_source_status and returns capability matrix', async () => {
    const result = await executeToolCall(
      { name: 'get_source_status', arguments: { chains: ['aldi', 'coop'] } },
      dependencies
    );

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      statuses: Array<{ chain: string; capability: string; status: string }>;
    };
    expect(structured.statuses.length).toBeGreaterThan(0);
    expect(structured.statuses.every((s) => ['aldi', 'coop'].includes(s.chain))).toBe(true);
  });
});
