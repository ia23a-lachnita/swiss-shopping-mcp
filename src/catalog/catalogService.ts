import type Database from 'better-sqlite3';
import type { Chain, NormalizedProduct } from '../adapters/types.js';
import type {
  CatalogPriceHistory,
  CatalogSearchResult,
  CatalogStats,
  ProductObservation,
  ProductStatus,
} from './types.js';
import { normalizeQuery } from './queryNormalizer.js';

export class CatalogService {
  private readonly db: Database.Database;
  private synonymGroups: Map<string, Set<string>> | null = null;

  public constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Build a bidirectional synonym map: for any term, return ALL terms that
   * share the same canonical form (including the term itself).
   */
  private buildSynonymGroups(): Map<string, Set<string>> {
    if (this.synonymGroups) return this.synonymGroups;

    const rows = this.db
      .prepare('SELECT term, canonical FROM synonyms')
      .all() as Array<{ term: string; canonical: string }>;

    // Group by canonical
    const byCanonical = new Map<string, Set<string>>();
    for (const row of rows) {
      const canonical = row.canonical.toLowerCase();
      if (!byCanonical.has(canonical)) {
        byCanonical.set(canonical, new Set());
      }
      byCanonical.get(canonical)!.add(canonical);
      byCanonical.get(canonical)!.add(row.term.toLowerCase());
    }

    // Build bidirectional map: each term → all terms in its group
    const map = new Map<string, Set<string>>();
    for (const group of byCanonical.values()) {
      for (const term of group) {
        map.set(term, group);
      }
    }

    this.synonymGroups = map;
    return map;
  }

  public invalidateSynonymCache(): void {
    this.synonymGroups = null;
  }

  public upsertFromNormalizedProduct(
    product: NormalizedProduct,
    source: string
  ): void {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        'SELECT consecutive_failures, gone_signals FROM products WHERE chain = ? AND product_id = ?'
      )
      .get(product.chain, product.id) as
      | { consecutive_failures: number; gone_signals: number }
      | undefined;

    const upsert = this.db.prepare(`
      INSERT INTO products (
        chain, product_id, name, brand, category, description,
        canonical_url, package_size, language, status,
        consecutive_failures, gone_signals,
        first_seen_at, last_seen_at, last_verified_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
      ON CONFLICT (chain, product_id) DO UPDATE SET
        name = excluded.name,
        brand = excluded.brand,
        category = excluded.category,
        description = excluded.description,
        canonical_url = excluded.canonical_url,
        package_size = excluded.package_size,
        language = excluded.language,
        status = 'active',
        consecutive_failures = 0,
        gone_signals = 0,
        last_seen_at = excluded.last_seen_at,
        last_verified_at = excluded.last_verified_at,
        metadata = excluded.metadata
    `);

    let firstSeen: string;
    if (existing) {
      const row = this.db
        .prepare(
          'SELECT first_seen_at FROM products WHERE chain = ? AND product_id = ?'
        )
        .get(product.chain, product.id) as { first_seen_at: string };
      firstSeen = row.first_seen_at;
    } else {
      firstSeen = now;
    }

    upsert.run(
      product.chain,
      product.id,
      product.name,
      product.brand ?? null,
      product.category ?? null,
      null,
      product.productUrl ?? null,
      product.size ?? null,
      null,
      existing?.consecutive_failures ?? 0,
      existing?.gone_signals ?? 0,
      firstSeen,
      now,
      now,
      null
    );

    // Append observation when price is present
    if (product.price && typeof product.price.current === 'number' && product.price.current > 0) {
      this.db
        .prepare(
          `INSERT INTO product_observations (
            chain, product_id, price, promotion_price, currency, availability, observed_at, source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          product.chain,
          product.id,
          product.price.current,
          product.price.original ?? null,
          'CHF',
          null,
          now,
          source
        );
    }
  }

  public recordHydrationFailure(
    chain: Chain,
    productId: string,
    kind: 'transient' | 'gone'
  ): void {
    const existing = this.db
      .prepare(
        'SELECT consecutive_failures, gone_signals, status FROM products WHERE chain = ? AND product_id = ?'
      )
      .get(chain, productId) as
      | { consecutive_failures: number; gone_signals: number; status: ProductStatus }
      | undefined;

    if (!existing) return;

    let newConsecutive = existing.consecutive_failures;
    let newGone = existing.gone_signals;
    let newStatus: ProductStatus = existing.status;

    if (kind === 'transient') {
      newConsecutive += 1;
      if (newConsecutive >= 3) {
        newStatus = 'suspected_removed';
      }
    } else {
      newGone += 1;
      if (newGone >= 3) {
        newStatus = 'removed';
      }
    }

    this.db
      .prepare(
        `UPDATE products
         SET consecutive_failures = ?, gone_signals = ?, status = ?
         WHERE chain = ? AND product_id = ?`
      )
      .run(newConsecutive, newGone, newStatus, chain, productId);
  }

  public search(
    queryText: string,
    opts: { limit?: number } = {}
  ): CatalogSearchResult[] {
    const normalized = normalizeQuery(queryText);
    if (!normalized) return [];

    const terms = normalized.split(' ').filter(Boolean);
    const synonymGroups = this.buildSynonymGroups();

    // Build FTS5 match query: AND across original terms, OR across synonyms of each term
    const termGroups = terms.map((term) => {
      const synonyms = synonymGroups.get(term) ?? new Set([term]);
      return [...synonyms]
        .map((s) => `"${s.replace(/"/g, '""')}"`)
        .join(' OR ');
    });

    const ftsQuery = termGroups.join(' AND ');

    if (!ftsQuery) return [];

    const limit = opts.limit ?? 20;

    const rows = this.db
      .prepare(
        `SELECT p.rowid, p.chain, p.product_id, p.name, p.brand, p.category,
                p.description, p.canonical_url, p.package_size, p.language,
                p.status, p.consecutive_failures, p.gone_signals,
                p.first_seen_at, p.last_seen_at, p.last_verified_at, p.metadata,
                fts.rank
         FROM products_fts fts
         JOIN products p ON p.rowid = fts.rowid
         WHERE products_fts MATCH ?
           AND p.status IN ('active', 'suspected_removed')
         ORDER BY fts.rank
         LIMIT ?`
      )
      .all(ftsQuery, limit) as Array<{
      rowid: number;
      chain: string;
      product_id: string;
      name: string;
      brand: string | null;
      category: string | null;
      description: string | null;
      canonical_url: string | null;
      package_size: string | null;
      language: string | null;
      status: ProductStatus;
      consecutive_failures: number;
      gone_signals: number;
      first_seen_at: string;
      last_seen_at: string;
      last_verified_at: string | null;
      metadata: string | null;
      rank: number;
    }>;

    return rows.map((row) => ({
      product: {
        chain: row.chain as Chain,
        productId: row.product_id,
        name: row.name,
        brand: row.brand,
        category: row.category,
        description: row.description,
        canonicalUrl: row.canonical_url,
        packageSize: row.package_size,
        language: row.language,
        status: row.status,
        consecutiveFailures: row.consecutive_failures,
        goneSignals: row.gone_signals,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        lastVerifiedAt: row.last_verified_at,
        metadata: row.metadata,
      },
      score: -row.rank,
      flagged: row.status === 'suspected_removed',
    }));
  }

  public latestObservation(
    chain: Chain,
    productId: string
  ): ProductObservation | undefined {
    const row = this.db
      .prepare(
        `SELECT id, chain, product_id, price, promotion_price, currency,
                availability, observed_at, source
         FROM product_observations
         WHERE chain = ? AND product_id = ?
         ORDER BY observed_at DESC
         LIMIT 1`
      )
      .get(chain, productId) as ProductObservation | undefined;

    return row ?? undefined;
  }

  public priceHistory(
    chain: Chain,
    productId: string,
    limit = 30
  ): CatalogPriceHistory[] {
    const rows = this.db
      .prepare(
        `SELECT price, promotion_price, currency, observed_at, source
         FROM product_observations
         WHERE chain = ? AND product_id = ?
         ORDER BY observed_at DESC
         LIMIT ?`
      )
      .all(chain, productId, limit) as Array<{
      price: number | null;
      promotion_price: number | null;
      currency: string | null;
      observed_at: string;
      source: string | null;
    }>;

    return rows.map((row) => ({
      price: row.price,
      promotionPrice: row.promotion_price,
      currency: row.currency,
      observedAt: row.observed_at,
      source: row.source,
    }));
  }

  public stats(): CatalogStats {
    const totalProducts = (
      this.db.prepare('SELECT COUNT(*) as c FROM products').get() as { c: number }
    ).c;

    const statusRows = this.db
      .prepare('SELECT status, COUNT(*) as c FROM products GROUP BY status')
      .all() as Array<{ status: ProductStatus; c: number }>;

    const productsByStatus: Record<ProductStatus, number> = {
      active: 0,
      suspected_removed: 0,
      removed: 0,
    };
    for (const row of statusRows) {
      productsByStatus[row.status] = row.c;
    }

    const chainRows = this.db
      .prepare('SELECT chain, COUNT(*) as c FROM products GROUP BY chain')
      .all() as Array<{ chain: string; c: number }>;

    const productsByChain: Record<string, number> = {};
    for (const row of chainRows) {
      productsByChain[row.chain] = row.c;
    }

    const totalObservations = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM product_observations')
        .get() as { c: number }
    ).c;

    return { totalProducts, productsByStatus, productsByChain, totalObservations };
  }

  public close(): void {
    this.db.close();
  }
}
