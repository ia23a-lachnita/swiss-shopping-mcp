import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CatalogService } from './catalogService.js';
import { SearchService } from '../services/searchService.js';
import { runMigrations } from './migrations.js';
import type {
  Chain,
  ChainAdapter,
  NormalizedProduct,
  ProductSearchFilters,
  Result,
  StoreAvailabilitySupport,
  StoreProductAvailabilityResult,
  NormalizedStore,
  NormalizedPromotion,
} from '../adapters/types.js';

function makeProduct(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    id: 'prod-001',
    chain: 'migros',
    name: 'Vollmilch',
    brand: 'Migros',
    price: { current: 1.95 },
    category: 'Milchprodukte',
    ...overrides,
  };
}

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('busy_timeout = 5000');
  runMigrations(db);
  return db;
}

function createMockAdapter(
  chain: Chain,
  products: NormalizedProduct[],
  opts: { supportsGetByIds?: boolean } = {}
): ChainAdapter {
  return {
    chain,
    async searchProducts(_filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
      return { ok: true, data: products };
    },
    async searchPromotions(): Promise<Result<NormalizedPromotion[]>> {
      return { ok: true, data: [] };
    },
    async findStores(): Promise<Result<NormalizedStore[]>> {
      return { ok: true, data: [] };
    },
    getStoreAvailabilitySupport(): StoreAvailabilitySupport {
      return { chain, supported: false };
    },
    async lookupStoreProductAvailability(): Promise<Result<StoreProductAvailabilityResult>> {
      return {
        ok: true,
        data: {
          chain,
          storeId: 's1',
          query: '',
          supported: false,
          matches: [],
          isAvailable: false,
        },
      };
    },
    ...(opts.supportsGetByIds
      ? {
          async getProductsByIds(ids: string[]): Promise<Result<NormalizedProduct[]>> {
            const found = products.filter((p) => ids.includes(p.id));
            return { ok: true, data: found };
          },
        }
      : {}),
  };
}

describe('Catalog ↔ SearchService wiring', () => {
  let db: Database.Database;
  let catalog: CatalogService;

  beforeEach(() => {
    db = createTestDb();
    catalog = new CatalogService(db);
  });

  afterEach(() => {
    catalog.close();
  });

  it('should upsert vendor results into catalog after search', async () => {
    const products = [
      makeProduct({ id: 'p1', name: 'Vollmilch', price: { current: 1.95 } }),
      makeProduct({ id: 'p2', name: 'Schokoladenmilch', price: { current: 2.50 } }),
    ];
    const adapter = createMockAdapter('migros', products);
    const searchService = new SearchService([adapter], { catalog });

    await searchService.searchProducts({ query: 'Milch', chains: ['migros'] });

    const stats = catalog.stats();
    expect(stats.totalProducts).toBe(2);
    expect(stats.productsByChain['migros']).toBe(2);
    expect(stats.totalObservations).toBe(2);
  });

  it('should search catalog and hydrate catalog-only hits', async () => {
    // Pre-populate catalog with a product that the adapter doesn't return
    const catalogProduct = makeProduct({
      id: 'catalog-p1',
      name: 'Bananenjoghurt',
      chain: 'migros',
      price: { current: 1.20 },
    });
    catalog.upsertFromNormalizedProduct(catalogProduct, 'previous-search');

    // Adapter only returns milk products
    const adapterProducts = [
      makeProduct({ id: 'p1', name: 'Vollmilch', price: { current: 1.95 } }),
    ];
    const adapter = createMockAdapter('migros', adapterProducts, {
      supportsGetByIds: true,
    });

    // Override getProductsByIds to also return the catalog product
    adapter.getProductsByIds = async (ids: string[]): Promise<Result<NormalizedProduct[]>> => {
      const allProducts = [...adapterProducts, catalogProduct];
      const found = allProducts.filter((p) => ids.includes(p.id));
      return { ok: true, data: found };
    };

    const searchService = new SearchService([adapter], { catalog });

    const result = await searchService.searchProducts({
      query: 'Joghurt',
      chains: ['migros'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should include both adapter results and catalog-hydrated results
      const names = result.data.map((p) => p.name);
      expect(names).toContain('Vollmilch');
      expect(names).toContain('Bananenjoghurt');
    }
  });

  it('should not fail the search when catalog write fails', async () => {
    const brokenCatalog = {
      upsertFromNormalizedProduct: () => {
        throw new Error('DB write failed');
      },
      search: () => [],
    } as unknown as CatalogService;

    const products = [makeProduct()];
    const adapter = createMockAdapter('migros', products);
    const searchService = new SearchService([adapter], { catalog: brokenCatalog });

    // Should not throw — catalog failure is non-fatal
    const result = await searchService.searchProducts({
      query: 'Milch',
      chains: ['migros'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.length).toBe(1);
    }
  });

  it('should not fail the search when catalog search fails', async () => {
    const brokenCatalog = {
      upsertFromNormalizedProduct: () => {},
      search: () => {
        throw new Error('FTS query failed');
      },
    } as unknown as CatalogService;

    const products = [makeProduct()];
    const adapter = createMockAdapter('migros', products);
    const searchService = new SearchService([adapter], { catalog: brokenCatalog });

    const result = await searchService.searchProducts({
      query: 'Milch',
      chains: ['migros'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.length).toBe(1);
    }
  });

  it('should work without catalog (undefined)', async () => {
    const products = [makeProduct()];
    const adapter = createMockAdapter('migros', products);
    const searchService = new SearchService([adapter]);

    const result = await searchService.searchProducts({
      query: 'Milch',
      chains: ['migros'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.length).toBe(1);
    }
  });

  it('should record gone when catalog-hydrated ID is missing from successful getProductsByIds', async () => {
    // Pre-populate catalog with two products
    const catalogP1 = makeProduct({ id: 'gone-p1', name: 'Verschwundenes Brot', chain: 'migros', price: { current: 3.50 } });
    const catalogP2 = makeProduct({ id: 'keep-p2', name: 'Joghurt', chain: 'migros', price: { current: 1.20 } });
    catalog.upsertFromNormalizedProduct(catalogP1, 'seed');
    catalog.upsertFromNormalizedProduct(catalogP2, 'seed');

    // Adapter vendor search returns nothing relevant to the catalog query
    const adapter = createMockAdapter('migros', [], { supportsGetByIds: true });

    // Override getProductsByIds: return only keep-p2, silently skip gone-p1
    adapter.getProductsByIds = async (ids: string[]): Promise<Result<NormalizedProduct[]>> => {
      const found = [catalogP2].filter((p) => ids.includes(p.id));
      return { ok: true, data: found };
    };

    const searchService = new SearchService([adapter], { catalog });
    const result = await searchService.searchProducts({
      query: 'Brot Joghurt',
      chains: ['migros'],
    });

    expect(result.ok).toBe(true);

    // gone-p1 should have gone_signals = 1 (first gone detection)
    const goneRow = db.prepare('SELECT gone_signals, consecutive_failures FROM products WHERE product_id = ?').get('gone-p1') as { gone_signals: number; consecutive_failures: number };
    expect(goneRow.gone_signals).toBe(1);
    expect(goneRow.consecutive_failures).toBe(0);

    // keep-p2 should have no failures
    const keepRow = db.prepare('SELECT gone_signals, consecutive_failures FROM products WHERE product_id = ?').get('keep-p2') as { gone_signals: number; consecutive_failures: number };
    expect(keepRow.gone_signals).toBe(0);
    expect(keepRow.consecutive_failures).toBe(0);
  });

  it('should record transient when getProductsByIds call fails for catalog hits', async () => {
    // Pre-populate catalog
    const catalogP1 = makeProduct({ id: 'fail-p1', name: 'Fehlendes Produkt', chain: 'migros', price: { current: 2.00 } });
    catalog.upsertFromNormalizedProduct(catalogP1, 'seed');

    const adapter = createMockAdapter('migros', [], { supportsGetByIds: true });

    // Override getProductsByIds to throw
    adapter.getProductsByIds = async (): Promise<Result<NormalizedProduct[]>> => {
      throw new Error('Network timeout');
    };

    const searchService = new SearchService([adapter], { catalog });
    const result = await searchService.searchProducts({
      query: 'Fehlendes',
      chains: ['migros'],
    });

    expect(result.ok).toBe(true);

    // fail-p1 should have consecutive_failures = 1
    const row = db.prepare('SELECT consecutive_failures, gone_signals FROM products WHERE product_id = ?').get('fail-p1') as { consecutive_failures: number; gone_signals: number };
    expect(row.consecutive_failures).toBe(1);
    expect(row.gone_signals).toBe(0);
  });

  it('should record transient when getProductsByIds returns error for catalog hits', async () => {
    // Pre-populate catalog
    const catalogP1 = makeProduct({ id: 'err-p1', name: 'Fehlerhaftes Produkt', chain: 'migros', price: { current: 2.00 } });
    catalog.upsertFromNormalizedProduct(catalogP1, 'seed');

    const adapter = createMockAdapter('migros', [], { supportsGetByIds: true });

    // Override getProductsByIds to return error result
    adapter.getProductsByIds = async (): Promise<Result<NormalizedProduct[]>> => {
      return { ok: false, error: { code: 'SOURCE_UNAVAILABLE', message: 'API down' } };
    };

    const searchService = new SearchService([adapter], { catalog });
    const result = await searchService.searchProducts({
      query: 'Fehlerhaftes',
      chains: ['migros'],
    });

    expect(result.ok).toBe(true);

    // err-p1 should have consecutive_failures = 1
    const row = db.prepare('SELECT consecutive_failures, gone_signals FROM products WHERE product_id = ?').get('err-p1') as { consecutive_failures: number; gone_signals: number };
    expect(row.consecutive_failures).toBe(1);
    expect(row.gone_signals).toBe(0);
  });

  it('should still succeed when catalog recordHydrationFailure throws', async () => {
    // Pre-populate catalog
    const catalogP1 = makeProduct({ id: 'robust-p1', name: 'Robustes Produkt', chain: 'migros', price: { current: 2.00 } });
    catalog.upsertFromNormalizedProduct(catalogP1, 'seed');

    // Wrap catalog with a broken recordHydrationFailure
    const brokenCatalog = new Proxy(catalog, {
      get(target, prop): unknown {
        if (prop === 'recordHydrationFailure') {
          return (): never => { throw new Error('Catalog write boom'); };
        }
        return Reflect.get(target, prop);
      },
    }) as CatalogService;

    const adapter = createMockAdapter('migros', [], { supportsGetByIds: true });
    // Return only a subset — missing ID would trigger recordHydrationFailure
    adapter.getProductsByIds = async (_ids: string[]): Promise<Result<NormalizedProduct[]>> => {
      return { ok: true, data: [] }; // returns nothing, so all IDs are "missing"
    };

    const searchService = new SearchService([adapter], { catalog: brokenCatalog });
    const result = await searchService.searchProducts({
      query: 'Robustes',
      chains: ['migros'],
    });

    expect(result.ok).toBe(true);
  });
});
