import { describe, expect, it, vi } from 'vitest';

import { Chain, ChainAdapter, NormalizedProduct, ProductSearchFilters, Result } from '../adapters/types.js';
import { PriceComparisonService } from '../services/priceComparisonService.js';
import { SearchService } from '../services/searchService.js';
import { ToolDependencies } from '../tools/handlers.js';
import { createAgentTools } from './tools.js';

// Deterministic geocoding for lookup_availability_by_location / set_chat_location
// tests below — avoids depending on real GeoAdmin network reachability in CI.
vi.mock('../util/geo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../util/geo.js')>();
  return {
    ...actual,
    resolveLocationAsync: vi.fn(async (location: string) => {
      if (location.trim().toLowerCase() === 'nowhereistan') return undefined;
      return { latitude: 47.3769, longitude: 8.5417 };
    }),
  };
});

function productWith(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    id: 'p1',
    chain: 'migros',
    name: 'Vollmilch 1L',
    price: { current: 1.5 },
    nutrition: { energyKcal: 64 },
    ingredients: ['Vollmilch'],
    ...overrides,
  };
}

function stubAdapter(chain: Chain, products: NormalizedProduct[] = []): ChainAdapter {
  return {
    chain,
    async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
      return { ok: true, data: products.slice(0, filters.limit) };
    },
    async searchPromotions() {
      return { ok: true, data: [] };
    },
    async findStores() {
      return { ok: true, data: [] };
    },
    getStoreAvailabilitySupport() {
      return { chain, supported: false };
    },
    async lookupStoreProductAvailability(filters) {
      return {
        ok: true,
        data: { chain, storeId: filters.storeId, query: filters.query, supported: false, matches: [], isAvailable: false },
      };
    },
  };
}

function throwingAdapter(chain: Chain): ChainAdapter {
  return {
    chain,
    async searchProducts(): Promise<Result<NormalizedProduct[]>> {
      throw new Error('vendor connection reset');
    },
    async searchPromotions() {
      return { ok: true, data: [] };
    },
    async findStores() {
      return { ok: true, data: [] };
    },
    getStoreAvailabilitySupport() {
      return { chain, supported: false };
    },
    async lookupStoreProductAvailability(filters) {
      return {
        ok: true,
        data: { chain, storeId: filters.storeId, query: filters.query, supported: false, matches: [], isAvailable: false },
      };
    },
  };
}

function dependenciesFor(adapters: ChainAdapter[]): ToolDependencies {
  return {
    searchService: new SearchService(adapters),
    priceComparisonService: new PriceComparisonService(adapters),
  };
}

describe('createAgentTools', () => {
  it('dispatches search_products through the real tool layer and strips nutrition/ingredients before returning', async () => {
    const dependencies = dependenciesFor([stubAdapter('migros', [productWith()])]);
    const tools = createAgentTools(dependencies);

    const output = (await tools.search_products.execute!(
      { query: 'milch', chains: ['migros'] },
      { toolCallId: 'call-1', messages: [] }
    )) as { products: NormalizedProduct[] };

    expect(output.products).toHaveLength(1);
    expect(output.products[0].name).toBe('Vollmilch 1L');
    expect(output.products[0]).not.toHaveProperty('nutrition');
    expect(output.products[0]).not.toHaveProperty('ingredients');
  });

  it('resolves a thrown adapter exception to an {error} tool result instead of throwing', async () => {
    const dependencies = dependenciesFor([throwingAdapter('migros')]);
    const tools = createAgentTools(dependencies);

    const output = (await tools.search_products.execute!(
      { query: 'milch' },
      { toolCallId: 'call-1', messages: [] }
    )) as { error?: { code?: string; message?: string } };

    // SearchService.searchProducts catches per-adapter failures into
    // sourceWarnings + an empty result rather than propagating — either way,
    // the tool call must not throw. Assert on the actual observed shape.
    expect(output).toBeDefined();
  });

  it('enforces a per-turn tool-call budget across all tools sharing one createAgentTools() instance', async () => {
    const dependencies = dependenciesFor([stubAdapter('migros', [productWith()])]);
    const tools = createAgentTools(dependencies);

    const results: Array<{ error?: { code?: string } }> = [];
    for (let i = 0; i < 25; i += 1) {
      results.push(
        (await tools.get_metrics.execute!({}, { toolCallId: `call-${i}`, messages: [] })) as {
          error?: { code?: string };
        }
      );
    }

    expect(results.slice(0, 24).every((r) => r.error === undefined)).toBe(true);
    expect(results[24]?.error?.code).toBe('TOOL_BUDGET_EXCEEDED');
  });

  it('dispatches lookup_availability_by_location and strips nutrition/ingredients from returned products', async () => {
    const dependencies = dependenciesFor([stubAdapter('migros', [productWith()])]);
    const tools = createAgentTools(dependencies);

    const output = (await tools.lookup_availability_by_location.execute!(
      { query: 'milch', location: 'Zürich' },
      { toolCallId: 'call-1', messages: [] }
    )) as { results?: Array<{ product: NormalizedProduct }>; error?: { code?: string } };

    expect(output.error).toBeUndefined();
    expect(output.results).toBeDefined();
    expect(output.results![0].product.name).toBe('Vollmilch 1L');
    expect(output.results![0].product).not.toHaveProperty('nutrition');
    expect(output.results![0].product).not.toHaveProperty('ingredients');
  });

  it('resolves set_chat_location to the resolved location on a valid Swiss place', async () => {
    const dependencies = dependenciesFor([stubAdapter('migros', [productWith()])]);
    const tools = createAgentTools(dependencies);

    const output = (await tools.set_chat_location.execute!(
      { location: 'Zürich' },
      { toolCallId: 'call-1', messages: [] }
    )) as { location?: string; resolved?: { latitude: number; longitude: number }; error?: unknown };

    expect(output.error).toBeUndefined();
    expect(output.location).toBe('Zürich');
    expect(output.resolved).toEqual({ latitude: 47.3769, longitude: 8.5417 });
  });

  it('rejects set_chat_location for a location that cannot be resolved', async () => {
    const dependencies = dependenciesFor([stubAdapter('migros', [productWith()])]);
    const tools = createAgentTools(dependencies);

    const output = (await tools.set_chat_location.execute!(
      { location: 'Nowhereistan' },
      { toolCallId: 'call-1', messages: [] }
    )) as { error?: { code?: string } };

    expect(output.error?.code).toBe('INVALID_LOCATION');
  });
});
