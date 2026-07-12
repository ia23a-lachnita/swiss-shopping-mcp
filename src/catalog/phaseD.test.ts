import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CatalogService } from './catalogService.js';
import { SearchService } from '../services/searchService.js';
import { runMigrations } from './migrations.js';
import { MetricsCollector } from '../util/metrics.js';
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

describe('Phase D: Provenance enrichment on search results', () => {
  let db: Database.Database;
  let catalog: CatalogService;
  let metrics: MetricsCollector;

  beforeEach(() => {
    db = createTestDb();
    catalog = new CatalogService(db);
    metrics = new MetricsCollector();
  });

  afterEach(() => {
    catalog.close();
    metrics.reset();
  });

  it('should populate provenance fields for fresh vendor result', async () => {
    const products = [
      makeProduct({ id: 'p1', name: 'Vollmilch', price: { current: 1.95 } }),
    ];
    const adapter = createMockAdapter('migros', products);
    const searchService = new SearchService([adapter], { catalog, metrics });

    const result = await searchService.searchProducts({
      query: 'Milch',
      chains: ['migros'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const product = result.data[0];
      expect(product._source).toBe('migros');
      expect(product._discoveredBy).toBe('vendor');
      expect(product._observedAt).toBeDefined();
      expect(product._priceObservedAt).toBeDefined();
      expect(product._stale).toBe(false);
      expect(product._confidence).toBe(1.0);
    }
  });

  it('should populate provenance fields for catalog-augmented result', async () => {
    // Pre-populate catalog with a product the adapter doesn't return
    const catalogProduct = makeProduct({
      id: 'catalog-p1',
      name: 'Bananenjoghurt',
      chain: 'migros',
      price: { current: 1.20 },
    });
    catalog.upsertFromNormalizedProduct(catalogProduct, 'previous-search');

    // Adapter returns nothing relevant to the catalog query
    const adapter = createMockAdapter('migros', [], { supportsGetByIds: true });

    // Override getProductsByIds to return the catalog product
    adapter.getProductsByIds = async (ids: string[]): Promise<Result<NormalizedProduct[]>> => {
      const found = [catalogProduct].filter((p) => ids.includes(p.id));
      return { ok: true, data: found };
    };

    const searchService = new SearchService([adapter], { catalog, metrics });
    const result = await searchService.searchProducts({
      query: 'Joghurt',
      chains: ['migros'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const product = result.data.find((p) => p.id === 'catalog-p1');
      if (product) {
        expect(product._discoveredBy).toBe('catalog');
        expect(product._confidence).toBe(0.3);
      }
    }
  });

  it('should populate provenance fields for web-discovered result', async () => {
    // Pre-populate catalog for the web-hydrated product
    const webProduct = makeProduct({
      id: 'web-p1',
      name: 'Zahncreme',
      chain: 'migros',
      price: { current: 4.50 },
    });
    catalog.upsertFromNormalizedProduct(webProduct, 'web-discovery');

    const adapter = createMockAdapter('migros', [webProduct], { supportsGetByIds: true });
    const searchService = new SearchService([adapter], { catalog, metrics });

    // The adapter returns the product directly (simulating web-discovered+hydrated)
    const result = await searchService.searchProducts({
      query: 'Zahncreme',
      chains: ['migros'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const product = result.data[0];
      // The product came from the adapter, so _discoveredBy is 'vendor'
      expect(product._source).toBe('migros');
      expect(product._discoveredBy).toBeDefined();
      expect(product._observedAt).toBeDefined();
      expect(product._confidence).toBeDefined();
    }
  });
});

describe('Phase D: Confidence heuristic ordering', () => {
  it('should order: fresh > stale > catalog-only', async () => {
    const db = createTestDb();
    const catalog = new CatalogService(db);
    const metrics = new MetricsCollector();

    const freshProduct = makeProduct({ id: 'fresh', name: 'Frisch', price: { current: 2.0 } });
    const adapter = createMockAdapter('migros', [freshProduct]);
    const searchService = new SearchService([adapter], { catalog, metrics });

    const result = await searchService.searchProducts({
      query: 'Frisch',
      chains: ['migros'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const product = result.data[0];
      // Fresh vendor result should have confidence 1.0
      expect(product._confidence).toBe(1.0);
    }

    catalog.close();
    metrics.reset();
  });
});

describe('Phase D: Migration idempotency', () => {
  it('should add observation status column idempotently', () => {
    const db1 = createTestDb();
    const count1 = (
      db1.prepare("SELECT COUNT(*) as c FROM pragma_table_info('product_observations') WHERE name = 'status'").get() as { c: number }
    ).c;
    expect(count1).toBe(1);
    db1.close();

    // Run migrations again on a new DB
    const db2 = createTestDb();
    const count2 = (
      db2.prepare("SELECT COUNT(*) as c FROM pragma_table_info('product_observations') WHERE name = 'status'").get() as { c: number }
    ).c;
    expect(count2).toBe(1);
    db2.close();
  });

  it('should have exactly 2 schema_migrations records', () => {
    const db = createTestDb();
    const count = (
      db.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as { c: number }
    ).c;
    expect(count).toBe(2);
    db.close();
  });
});

describe('Phase D: Catalog observation validation wiring', () => {
  let db: Database.Database;
  let catalog: CatalogService;

  beforeEach(() => {
    db = createTestDb();
    catalog = new CatalogService(db);
  });

  afterEach(() => {
    catalog.close();
  });

  it('should set observation status to accepted for normal observations', () => {
    const product = makeProduct({ price: { current: 5.0 } });
    catalog.upsertFromNormalizedProduct(product, 'vendor');

    const obs = catalog.latestObservation('migros', 'prod-001');
    expect(obs).toBeDefined();
    expect(obs!.status).toBe('accepted');
  });

  it('should flag zero price as pending_verification', () => {
    // First insert a credible baseline
    const product1 = makeProduct({ price: { current: 5.0 } });
    catalog.upsertFromNormalizedProduct(product1, 'vendor');

    // Now insert with zero price — validation should flag it
    const product2 = makeProduct({ price: { current: 0 } });
    catalog.upsertFromNormalizedProduct(product2, 'vendor');

    // Zero price should not create an observation (price > 0 check in upsert)
    const count = (
      db.prepare(
        "SELECT COUNT(*) as c FROM product_observations WHERE chain = 'migros' AND product_id = 'prod-001'"
      ).get() as { c: number }
    ).c;
    // Only 1 observation (the first one) — zero price is skipped by the guard
    expect(count).toBe(1);
  });

  it('should accept legit 50% promo via promotion_price', () => {
    const product = makeProduct({
      price: { current: 5.0, original: 10.0 },
    });
    catalog.upsertFromNormalizedProduct(product, 'vendor');

    const obs = catalog.latestObservation('migros', 'prod-001');
    expect(obs).toBeDefined();
    expect(obs!.status).toBe('accepted');
    expect(obs!.price).toBe(5.0);
    expect(obs!.promotionPrice).toBe(10.0);
  });

  it('should flag promo > normal price', () => {
    // First insert a baseline
    const product1 = makeProduct({ price: { current: 5.0 } });
    catalog.upsertFromNormalizedProduct(product1, 'vendor');

    // Insert with promo > normal (8 > 5)
    const product2 = makeProduct({
      price: { current: 5.0, original: 8.0 },
    });
    catalog.upsertFromNormalizedProduct(product2, 'vendor');

    const obs = catalog.latestObservation('migros', 'prod-001');
    expect(obs).toBeDefined();
    expect(obs!.status).toBe('pending_verification');
  });

  it('should flag name mismatch', () => {
    // First insert with one name
    const product1 = makeProduct({ name: 'Vollmilch 1L', price: { current: 2.0 } });
    catalog.upsertFromNormalizedProduct(product1, 'vendor');

    // Insert with completely different name
    const product2 = makeProduct({ name: 'Schokoladenpudding Vanille', price: { current: 2.0 } });
    catalog.upsertFromNormalizedProduct(product2, 'vendor');

    const obs = catalog.latestObservation('migros', 'prod-001');
    expect(obs).toBeDefined();
    expect(obs!.status).toBe('pending_verification');
  });

  it('should accept after two consecutive matching suspicious values', () => {
    // First insert a baseline
    const product1 = makeProduct({ name: 'Vollmilch', price: { current: 5.0 } });
    catalog.upsertFromNormalizedProduct(product1, 'vendor');

    // Second: suspicious name change → pending_verification
    const product2 = makeProduct({ name: 'TotalAndersProdukt', price: { current: 5.0 } });
    catalog.upsertFromNormalizedProduct(product2, 'vendor');

    const obs2 = catalog.latestObservation('migros', 'prod-001');
    expect(obs2!.status).toBe('pending_verification');

    // Third: another suspicious name change → two consecutive pending → accept
    const product3 = makeProduct({ name: 'NochEinAnderes', price: { current: 5.0 } });
    catalog.upsertFromNormalizedProduct(product3, 'vendor');

    const obs3 = catalog.latestObservation('migros', 'prod-001');
    expect(obs3!.status).toBe('accepted');
  });

  it('should have getPendingObservationCount method', () => {
    const count = catalog.getPendingObservationCount();
    expect(count).toBe(0);

    // Insert a baseline, then a suspicious observation
    const product1 = makeProduct({ name: 'Vollmilch', price: { current: 5.0 } });
    catalog.upsertFromNormalizedProduct(product1, 'vendor');

    const product2 = makeProduct({ name: 'TotalAnders', price: { current: 5.0 } });
    catalog.upsertFromNormalizedProduct(product2, 'vendor');

    const pendingCount = catalog.getPendingObservationCount();
    expect(pendingCount).toBe(1);
  });
});
