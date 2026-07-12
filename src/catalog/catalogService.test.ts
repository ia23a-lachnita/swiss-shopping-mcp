import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CatalogService } from './catalogService.js';
import { runMigrations } from './migrations.js';
import { normalizeQuery } from './queryNormalizer.js';
import type { NormalizedProduct } from '../adapters/types.js';

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

describe('CatalogService', () => {
  let db: Database.Database;
  let service: CatalogService;

  beforeEach(() => {
    db = createTestDb();
    service = new CatalogService(db);
  });

  afterEach(() => {
    service.close();
  });

  describe('busy timeout', () => {
    it('should have busy timeout set to 5000ms', () => {
      const result = db.pragma('busy_timeout', { simple: true }) as number;
      expect(result).toBe(5000);
    });
  });

  describe('Migration idempotency', () => {
    it('should run migrations twice without error', () => {
      const db2 = createTestDb();
      runMigrations(db2);
      runMigrations(db2);

      const count = (
        db2.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as { c: number }
      ).c;
      expect(count).toBe(1);
      db2.close();
    });
  });

  describe('upsertFromNormalizedProduct', () => {
    it('should insert a new product', () => {
      const product = makeProduct();
      service.upsertFromNormalizedProduct(product, 'vendor-search');

      const row = db
        .prepare('SELECT * FROM products WHERE chain = ? AND product_id = ?')
        .get('migros', 'prod-001') as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.name).toBe('Vollmilch');
      expect(row.brand).toBe('Migros');
      expect(row.status).toBe('active');
      expect(row.consecutive_failures).toBe(0);
      expect(row.gone_signals).toBe(0);
      expect(row.first_seen_at).toBeDefined();
      expect(row.last_seen_at).toBeDefined();
    });

    it('should append an observation when price is present', () => {
      const product = makeProduct({ price: { current: 2.50 } });
      service.upsertFromNormalizedProduct(product, 'vendor-search');

      const obs = db
        .prepare(
          'SELECT * FROM product_observations WHERE chain = ? AND product_id = ?'
        )
        .get('migros', 'prod-001') as Record<string, unknown>;

      expect(obs).toBeDefined();
      expect(obs.price).toBe(2.50);
      expect(obs.source).toBe('vendor-search');
    });

    it('should not append observation when price is zero', () => {
      const product = makeProduct({ price: { current: 0 } });
      service.upsertFromNormalizedProduct(product, 'vendor-search');

      const count = (
        db
          .prepare(
            'SELECT COUNT(*) as c FROM product_observations WHERE chain = ? AND product_id = ?'
          )
          .get('migros', 'prod-001') as { c: number }
      ).c;
      expect(count).toBe(0);
    });

    it('should update existing product and reset counters', () => {
      const product = makeProduct();
      service.upsertFromNormalizedProduct(product, 'vendor-search');

      service.recordHydrationFailure('migros', 'prod-001', 'transient');
      service.recordHydrationFailure('migros', 'prod-001', 'transient');

      const before = db
        .prepare('SELECT consecutive_failures FROM products WHERE chain = ? AND product_id = ?')
        .get('migros', 'prod-001') as { consecutive_failures: number };
      expect(before.consecutive_failures).toBe(2);

      service.upsertFromNormalizedProduct(product, 'vendor-search');

      const after = db
        .prepare(
          'SELECT consecutive_failures, gone_signals, status FROM products WHERE chain = ? AND product_id = ?'
        )
        .get('migros', 'prod-001') as {
        consecutive_failures: number;
        gone_signals: number;
        status: string;
      };
      expect(after.consecutive_failures).toBe(0);
      expect(after.gone_signals).toBe(0);
      expect(after.status).toBe('active');
    });

    it('should preserve first_seen_at on re-upsert', () => {
      const product = makeProduct();
      service.upsertFromNormalizedProduct(product, 'vendor-search');

      const first = db
        .prepare('SELECT first_seen_at FROM products WHERE chain = ? AND product_id = ?')
        .get('migros', 'prod-001') as { first_seen_at: string };

      service.upsertFromNormalizedProduct(product, 'vendor-search');

      const second = db
        .prepare('SELECT first_seen_at FROM products WHERE chain = ? AND product_id = ?')
        .get('migros', 'prod-001') as { first_seen_at: string };

      expect(second.first_seen_at).toBe(first.first_seen_at);
    });
  });

  describe('recordHydrationFailure lifecycle', () => {
    it('should not change status on single failure', () => {
      const product = makeProduct();
      service.upsertFromNormalizedProduct(product, 'test');

      service.recordHydrationFailure('migros', 'prod-001', 'transient');

      const row = db
        .prepare('SELECT status, consecutive_failures FROM products WHERE chain = ? AND product_id = ?')
        .get('migros', 'prod-001') as { status: string; consecutive_failures: number };

      expect(row.status).toBe('active');
      expect(row.consecutive_failures).toBe(1);
    });

    it('should transition to suspected_removed after 3 transient failures', () => {
      const product = makeProduct();
      service.upsertFromNormalizedProduct(product, 'test');

      service.recordHydrationFailure('migros', 'prod-001', 'transient');
      service.recordHydrationFailure('migros', 'prod-001', 'transient');
      service.recordHydrationFailure('migros', 'prod-001', 'transient');

      const row = db
        .prepare('SELECT status FROM products WHERE chain = ? AND product_id = ?')
        .get('migros', 'prod-001') as { status: string };

      expect(row.status).toBe('suspected_removed');
    });

    it('should transition to removed after 3 gone signals', () => {
      const product = makeProduct();
      service.upsertFromNormalizedProduct(product, 'test');

      service.recordHydrationFailure('migros', 'prod-001', 'gone');
      service.recordHydrationFailure('migros', 'prod-001', 'gone');
      service.recordHydrationFailure('migros', 'prod-001', 'gone');

      const row = db
        .prepare('SELECT status FROM products WHERE chain = ? AND product_id = ?')
        .get('migros', 'prod-001') as { status: string };

      expect(row.status).toBe('removed');
    });

    it('should not demote on a single gone signal', () => {
      const product = makeProduct();
      service.upsertFromNormalizedProduct(product, 'test');

      service.recordHydrationFailure('migros', 'prod-001', 'gone');

      const row = db
        .prepare('SELECT status, gone_signals FROM products WHERE chain = ? AND product_id = ?')
        .get('migros', 'prod-001') as { status: string; gone_signals: number };

      expect(row.status).toBe('active');
      expect(row.gone_signals).toBe(1);
    });

    it('should restore active status on successful re-upsert', () => {
      const product = makeProduct();
      service.upsertFromNormalizedProduct(product, 'test');

      service.recordHydrationFailure('migros', 'prod-001', 'transient');
      service.recordHydrationFailure('migros', 'prod-001', 'transient');

      service.upsertFromNormalizedProduct(product, 'test');

      const row = db
        .prepare(
          'SELECT status, consecutive_failures, gone_signals FROM products WHERE chain = ? AND product_id = ?'
        )
        .get('migros', 'prod-001') as {
        status: string;
        consecutive_failures: number;
        gone_signals: number;
      };

      expect(row.status).toBe('active');
      expect(row.consecutive_failures).toBe(0);
      expect(row.gone_signals).toBe(0);
    });

    it('should do nothing when product does not exist', () => {
      service.recordHydrationFailure('migros', 'nonexistent', 'transient');
    });
  });

  describe('FTS search with synonym expansion', () => {
    it('should find "Milch" when searching "milk"', () => {
      const product = makeProduct({ name: 'Vollmilch' });
      service.upsertFromNormalizedProduct(product, 'test');

      const results = service.search('milk');
      expect(results.length).toBe(1);
      expect(results[0].product.name).toBe('Vollmilch');
    });

    it('should find "Milch" when searching "Milch"', () => {
      const product = makeProduct({ name: 'Vollmilch' });
      service.upsertFromNormalizedProduct(product, 'test');

      const results = service.search('Milch');
      expect(results.length).toBe(1);
    });

    it('should find "Brot" when searching "bread"', () => {
      const product = makeProduct({ name: 'Roggenbrot', id: 'prod-002' });
      service.upsertFromNormalizedProduct(product, 'test');

      const results = service.search('bread');
      expect(results.length).toBe(1);
      expect(results[0].product.name).toBe('Roggenbrot');
    });

    it('should exclude removed products', () => {
      const product = makeProduct();
      service.upsertFromNormalizedProduct(product, 'test');

      service.recordHydrationFailure('migros', 'prod-001', 'gone');
      service.recordHydrationFailure('migros', 'prod-001', 'gone');
      service.recordHydrationFailure('migros', 'prod-001', 'gone');

      const results = service.search('Milch');
      expect(results.length).toBe(0);
    });

    it('should flag suspected_removed products', () => {
      const product = makeProduct();
      service.upsertFromNormalizedProduct(product, 'test');

      service.recordHydrationFailure('migros', 'prod-001', 'transient');
      service.recordHydrationFailure('migros', 'prod-001', 'transient');
      service.recordHydrationFailure('migros', 'prod-001', 'transient');

      const results = service.search('Milch');
      expect(results.length).toBe(1);
      expect(results[0].flagged).toBe(true);
    });

    it('should return empty array for empty query', () => {
      expect(service.search('')).toEqual([]);
      expect(service.search('   ')).toEqual([]);
    });
  });

  describe('Observations are append-only', () => {
    it('should retain multiple observations in order', () => {
      const product1 = makeProduct({ price: { current: 1.95 } });
      service.upsertFromNormalizedProduct(product1, 'source-1');

      const product2 = makeProduct({ price: { current: 2.10 } });
      service.upsertFromNormalizedProduct(product2, 'source-2');

      const product3 = makeProduct({ price: { current: 1.85 } });
      service.upsertFromNormalizedProduct(product3, 'source-3');

      const count = (
        db
          .prepare(
            'SELECT COUNT(*) as c FROM product_observations WHERE chain = ? AND product_id = ?'
          )
          .get('migros', 'prod-001') as { c: number }
      ).c;
      expect(count).toBe(3);
    });

    it('should return correct latestObservation', () => {
      const product1 = makeProduct({ price: { current: 1.95 } });
      service.upsertFromNormalizedProduct(product1, 'source-1');

      const product2 = makeProduct({ price: { current: 2.10 } });
      service.upsertFromNormalizedProduct(product2, 'source-2');

      const latest = service.latestObservation('migros', 'prod-001');
      expect(latest).toBeDefined();
      expect(latest!.price).toBe(2.10);
      expect(latest!.source).toBe('source-2');
    });

    it('should return correct priceHistory', () => {
      const product1 = makeProduct({ price: { current: 1.95 } });
      service.upsertFromNormalizedProduct(product1, 'source-1');

      const product2 = makeProduct({ price: { current: 2.10 } });
      service.upsertFromNormalizedProduct(product2, 'source-2');

      const history = service.priceHistory('migros', 'prod-001', 10);
      expect(history.length).toBe(2);
      expect(history[0].price).toBe(2.10);
      expect(history[1].price).toBe(1.95);
    });

    it('should return undefined for nonexistent product', () => {
      const latest = service.latestObservation('migros', 'nonexistent');
      expect(latest).toBeUndefined();
    });
  });

  describe('stats()', () => {
    it('should return correct counts', () => {
      const p1 = makeProduct({ id: 'p1' });
      const p2 = makeProduct({ id: 'p2', chain: 'coop' });
      service.upsertFromNormalizedProduct(p1, 'test');
      service.upsertFromNormalizedProduct(p2, 'test');

      const stats = service.stats();
      expect(stats.totalProducts).toBe(2);
      expect(stats.productsByStatus.active).toBe(2);
      expect(stats.productsByChain['migros']).toBe(1);
      expect(stats.productsByChain['coop']).toBe(1);
      expect(stats.totalObservations).toBe(2);
    });
  });
});

describe('normalizeQuery', () => {
  it('should lowercase and trim', () => {
    expect(normalizeQuery('  Vollmilch  ')).toBe('vollmilch');
  });

  it('should collapse whitespace', () => {
    expect(normalizeQuery('hello   world')).toBe('hello world');
  });

  it('should strip punctuation', () => {
    expect(normalizeQuery('kaffee! (gemahlen)')).toBe('kaffee gemahlen');
  });

  it('should apply Unicode NFD and strip combining marks', () => {
    expect(normalizeQuery('Käse')).toBe('kase');
    expect(normalizeQuery('Über')).toBe('uber');
  });

  it('should canonicalize liter units to ml', () => {
    expect(normalizeQuery('1 l')).toBe('1000ml');
    expect(normalizeQuery('1L')).toBe('1000ml');
    expect(normalizeQuery('1000 ml')).toBe('1000ml');
    expect(normalizeQuery('50 cl')).toBe('500ml');
  });

  it('should canonicalize weight units to g', () => {
    expect(normalizeQuery('500 g')).toBe('500g');
    expect(normalizeQuery('0.5 kg')).toBe('500g');
    expect(normalizeQuery('1 kg')).toBe('1000g');
  });

  it('should fold German plurals', () => {
    expect(normalizeQuery('Tomaten')).toBe('tomate');
    expect(normalizeQuery('Äpfel')).toBe('apfel');
    expect(normalizeQuery('Eier')).toBe('ei');
    expect(normalizeQuery('Nudeln')).toBe('nudel');
  });

  it('should not over-normalize "laktosefrei"', () => {
    const result = normalizeQuery('laktosefrei');
    expect(result).toBe('laktosefrei');
  });

  it('should handle empty input', () => {
    expect(normalizeQuery('')).toBe('');
    expect(normalizeQuery('   ')).toBe('');
  });
});
