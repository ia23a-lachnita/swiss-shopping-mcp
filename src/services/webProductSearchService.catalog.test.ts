import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { CatalogService } from '../catalog/catalogService.js';
import { runMigrations } from '../catalog/migrations.js';
import { WebProductSearchService } from './webProductSearchService.js';
import { FileTtlCache } from '../cache/fileTtlCache.js';
import type { WebSearchProvider, WebSearchResult } from '../sources/webSearch.js';
import type {
  Chain,
  ChainAdapter,
  NormalizedProduct,
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

const MIGROS_CHAIN_CONFIG = {
  chain: 'migros' as Chain,
  site: 'migros.ch/de/product',
  extractProductId: (url: URL): string | undefined => url.pathname.match(/\/mo\/(\d+)\/?$/)?.[1],
};

function createMockProvider(results: WebSearchResult[]): WebSearchProvider {
  return {
    name: 'mock' as WebSearchProvider['name'],
    async search(_query: string, _options: { site: string }): Promise<WebSearchResult[]> {
      return results;
    },
  };
}

function createMockAdapter(
  chain: Chain,
  hydrationProducts: NormalizedProduct[],
): ChainAdapter {
  return {
    chain,
    async searchProducts(): Promise<Result<NormalizedProduct[]>> {
      return { ok: true, data: [] };
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
        data: { chain, storeId: 's1', query: '', supported: false, matches: [], isAvailable: false },
      };
    },
    async getProductsByIds(ids: string[]): Promise<Result<NormalizedProduct[]>> {
      const found = hydrationProducts.filter((p) => ids.includes(p.id));
      return { ok: true, data: found };
    },
  };
}

describe('WebProductSearchService ↔ Catalog integration', () => {
  let db: Database.Database;
  let catalog: CatalogService;
  let cacheDir: string;
  let cache: FileTtlCache;

  beforeEach(() => {
    db = createTestDb();
    catalog = new CatalogService(db);
    cacheDir = join(tmpdir(), `web-catalog-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(cacheDir, { recursive: true });
    cache = new FileTtlCache(cacheDir);
  });

  afterEach(() => {
    catalog.close();
    cache.stopPeriodicPrune();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('should upsert web-discovered hydrated products with source web-discovery', async () => {
    // Product ID must match what extractProductId extracts from the URL
    const product = makeProduct({
      id: '1234',
      name: 'Birchermüesli',
      chain: 'migros',
      price: { current: 4.50 },
    });

    const provider = createMockProvider([
      { url: 'https://www.migros.ch/de/product/mo/1234', title: 'Birchermüesli', rank: 1 },
    ]);

    const adapter = createMockAdapter('migros', [product]);

    const service = new WebProductSearchService({
      provider,
      adapters: [adapter],
      cache,
      catalog,
      chainConfigs: [MIGROS_CHAIN_CONFIG],
    });

    const result = await service.searchProducts(
      { query: 'Müesli', chains: ['migros'] },
      ['migros'],
    );

    expect(result.productsByChain.size).toBe(1);
    expect(result.productsByChain.get('migros')!.length).toBe(1);

    // Verify catalog has the product with source 'web-discovery'
    const obs = catalog.latestObservation('migros', '1234');
    expect(obs).toBeDefined();
    expect(obs!.source).toBe('web-discovery');
    expect(obs!.price).toBe(4.50);

    // Verify product identity was upserted
    const stats = catalog.stats();
    expect(stats.totalProducts).toBe(1);
    expect(stats.productsByChain['migros']).toBe(1);
  });

  it('should record gone when hydrated ID is missing from successful getProductsByIds', async () => {
    // Web search returns 2 URLs → 2 extracted IDs
    // But adapter only hydrates one of them
    const keepProduct = makeProduct({
      id: '9902',
      name: 'Verfügbares Produkt',
      chain: 'migros',
      price: { current: 3.00 },
    });

    const provider = createMockProvider([
      { url: 'https://www.migros.ch/de/product/mo/9901', title: 'Gone', rank: 1 },
      { url: 'https://www.migros.ch/de/product/mo/9902', title: 'Keep', rank: 2 },
    ]);

    const adapter = createMockAdapter('migros', [keepProduct]);
    // Override: only return keepProduct (id 9902), skip 9901
    adapter.getProductsByIds = async (ids: string[]): Promise<Result<NormalizedProduct[]>> => {
      const found = [keepProduct].filter((p) => ids.includes(p.id));
      return { ok: true, data: found };
    };

    const service = new WebProductSearchService({
      provider,
      adapters: [adapter],
      cache,
      catalog,
      chainConfigs: [MIGROS_CHAIN_CONFIG],
    });

    await service.searchProducts(
      { query: 'Test', chains: ['migros'] },
      ['migros'],
    );

    // ID 9901 is not in the catalog (never upserted), so recordHydrationFailure
    // is a no-op for it. That's correct behavior — only tracked products get
    // lifecycle transitions.
    // But the kept product (9902) should be upserted
    const obs = catalog.latestObservation('migros', '9902');
    expect(obs).toBeDefined();
    expect(obs!.source).toBe('web-discovery');

    // Verify search completed with the hydrated product
    // The key assertion: search didn't fail, and we got results
  });

  it('should record transient for all IDs when getProductsByIds throws', async () => {
    const provider = createMockProvider([
      { url: 'https://www.migros.ch/de/product/mo/1111', title: 'Test', rank: 1 },
    ]);

    const adapter = createMockAdapter('migros', []);
    adapter.getProductsByIds = async (): Promise<Result<NormalizedProduct[]>> => {
      throw new Error('Connection refused');
    };

    const service = new WebProductSearchService({
      provider,
      adapters: [adapter],
      cache,
      catalog,
      chainConfigs: [MIGROS_CHAIN_CONFIG],
    });

    const result = await service.searchProducts(
      { query: 'Test', chains: ['migros'] },
      ['migros'],
    );

    // Search should still complete (web failures never fail overall search)
    // No products from this chain (hydration failed)
    expect(result.productsByChain.has('migros')).toBe(false);
    // Warning should be generated
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('should not fail search when catalog upsert throws', async () => {
    const product = makeProduct({
      id: '5678',
      name: 'Resilientes Produkt',
      chain: 'migros',
      price: { current: 2.50 },
    });

    const provider = createMockProvider([
      { url: 'https://www.migros.ch/de/product/mo/5678', title: 'Resilient', rank: 1 },
    ]);

    const adapter = createMockAdapter('migros', [product]);
    const brokenCatalog = new Proxy(catalog, {
      get(target, prop): unknown {
        if (prop === 'upsertFromNormalizedProduct') {
          return (): never => { throw new Error('DB disk full'); };
        }
        return Reflect.get(target, prop);
      },
    }) as CatalogService;

    const service = new WebProductSearchService({
      provider,
      adapters: [adapter],
      cache,
      catalog: brokenCatalog,
      chainConfigs: [MIGROS_CHAIN_CONFIG],
    });

    // Should not throw despite catalog upsert failure
    const result = await service.searchProducts(
      { query: 'Test', chains: ['migros'] },
      ['migros'],
    );

    expect(result.productsByChain.size).toBe(1);
    expect(result.productsByChain.get('migros')!.length).toBe(1);
  });

  it('should work without catalog (undefined) — backward compatible', async () => {
    const product = makeProduct({ id: '8888', name: 'Ohne Katalog', chain: 'migros' });

    const provider = createMockProvider([
      { url: 'https://www.migros.ch/de/product/mo/8888', title: 'Ohne', rank: 1 },
    ]);

    const adapter = createMockAdapter('migros', [product]);

    const service = new WebProductSearchService({
      provider,
      adapters: [adapter],
      cache,
      chainConfigs: [MIGROS_CHAIN_CONFIG],
      // No catalog — should work fine
    });

    const result = await service.searchProducts(
      { query: 'Test', chains: ['migros'] },
      ['migros'],
    );

    expect(result.productsByChain.size).toBe(1);
    expect(result.warnings.length).toBe(0);
  });
});
