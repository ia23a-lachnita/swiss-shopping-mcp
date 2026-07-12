import type Database from 'better-sqlite3';

interface Migration {
  readonly version: number;
  readonly up: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS products (
        chain TEXT NOT NULL,
        product_id TEXT NOT NULL,
        name TEXT NOT NULL,
        brand TEXT,
        category TEXT,
        description TEXT,
        canonical_url TEXT,
        package_size TEXT,
        language TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        gone_signals INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_verified_at TEXT,
        metadata TEXT,
        PRIMARY KEY (chain, product_id)
      );

      CREATE TABLE IF NOT EXISTS product_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain TEXT NOT NULL,
        product_id TEXT NOT NULL,
        price REAL,
        promotion_price REAL,
        currency TEXT,
        availability TEXT,
        observed_at TEXT NOT NULL,
        source TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_observations_chain_product
        ON product_observations (chain, product_id, observed_at);

      CREATE TABLE IF NOT EXISTS synonyms (
        term TEXT NOT NULL,
        canonical TEXT NOT NULL,
        lang TEXT NOT NULL DEFAULT 'de'
      );

      CREATE INDEX IF NOT EXISTS idx_synonyms_term
        ON synonyms (term, lang);
      CREATE INDEX IF NOT EXISTS idx_synonyms_canonical
        ON synonyms (canonical, lang);

      CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
        name,
        brand,
        category,
        description,
        content=products,
        content_rowid=rowid,
        tokenize='trigram'
      );

      -- Triggers to keep FTS in sync with products
      CREATE TRIGGER IF NOT EXISTS products_ai AFTER INSERT ON products BEGIN
        INSERT INTO products_fts(rowid, name, brand, category, description)
        VALUES (new.rowid, new.name, new.brand, new.category, new.description);
      END;

      CREATE TRIGGER IF NOT EXISTS products_ad AFTER DELETE ON products BEGIN
        INSERT INTO products_fts(products_fts, rowid, name, brand, category, description)
        VALUES ('delete', old.rowid, old.name, old.brand, old.category, old.description);
      END;

      CREATE TRIGGER IF NOT EXISTS products_au AFTER UPDATE ON products BEGIN
        INSERT INTO products_fts(products_fts, rowid, name, brand, category, description)
        VALUES ('delete', old.rowid, old.name, old.brand, old.category, old.description);
        INSERT INTO products_fts(rowid, name, brand, category, description)
        VALUES (new.rowid, new.name, new.brand, new.category, new.description);
      END;

      -- Seed common Swiss grocery multilingual synonyms
      INSERT OR IGNORE INTO synonyms (term, canonical, lang) VALUES
        ('milch', 'milk', 'de'), ('milk', 'milk', 'en'), ('lait', 'milk', 'fr'), ('latte', 'milk', 'it'),
        ('brot', 'bread', 'de'), ('bread', 'bread', 'en'), ('pain', 'bread', 'fr'), ('pane', 'bread', 'it'),
        ('kase', 'cheese', 'de'), ('käse', 'cheese', 'de'), ('cheese', 'cheese', 'en'), ('fromage', 'cheese', 'fr'), ('formaggio', 'cheese', 'it'),
        ('tomate', 'tomato', 'de'), ('tomaten', 'tomato', 'de'), ('tomato', 'tomato', 'en'), ('tomate', 'tomato', 'fr'), ('pomodoro', 'tomato', 'it'),
        ('apfel', 'apple', 'de'), ('äpfel', 'apple', 'de'), ('apple', 'apple', 'en'), ('pomme', 'apple', 'fr'), ('mela', 'apple', 'it'),
        ('poulet', 'chicken', 'fr'), ('chicken', 'chicken', 'en'), ('huhn', 'chicken', 'de'), ('pollo', 'chicken', 'it'),
        ('wasser', 'water', 'de'), ('water', 'water', 'en'), ('eau', 'water', 'fr'), ('acqua', 'water', 'it'),
        ('bier', 'beer', 'de'), ('beer', 'beer', 'en'), ('biere', 'beer', 'de'), ('bière', 'beer', 'fr'),
        ('wein', 'wine', 'de'), ('wine', 'wine', 'en'), ('vin', 'wine', 'fr'), ('vino', 'wine', 'it'),
        ('joghurt', 'yogurt', 'de'), ('yogurt', 'yogurt', 'en'), ('yogourt', 'yogurt', 'fr'),
        ('butter', 'butter', 'de'), ('butter', 'butter', 'en'), ('beurre', 'butter', 'fr'), ('burro', 'butter', 'it'),
        ('eier', 'eggs', 'de'), ('eggs', 'eggs', 'en'), ('oeuf', 'eggs', 'fr'), ('uova', 'eggs', 'it'),
        ('kaffee', 'coffee', 'de'), ('coffee', 'coffee', 'en'), ('café', 'coffee', 'fr'), ('caffè', 'coffee', 'it'),
        ('tee', 'tea', 'de'), ('tea', 'tea', 'en'), ('thé', 'tea', 'fr'), ('tè', 'tea', 'it'),
        ('zucker', 'sugar', 'de'), ('sugar', 'sugar', 'en'), ('sucre', 'sugar', 'fr'), ('zucchero', 'sugar', 'it'),
        ('salz', 'salt', 'de'), ('salt', 'salt', 'en'), ('sel', 'salt', 'fr'), ('sale', 'salt', 'it'),
        ('nudeln', 'pasta', 'de'), ('pasta', 'pasta', 'it'), ('pasta', 'pasta', 'en'), ('pâtes', 'pasta', 'fr'),
        ('reis', 'rice', 'de'), ('rice', 'rice', 'en'), ('riz', 'rice', 'fr'), ('riso', 'rice', 'it'),
        ('fleisch', 'meat', 'de'), ('meat', 'meat', 'en'), ('viande', 'meat', 'fr'), ('carne', 'meat', 'it'),
        ('fisch', 'fish', 'de'), ('fish', 'fish', 'en'), ('poisson', 'fish', 'fr'), ('pesce', 'fish', 'it'),
        ('obst', 'fruit', 'de'), ('fruit', 'fruit', 'en'), ('fruits', 'fruit', 'fr'), ('frutta', 'fruit', 'it'),
        ('gemuse', 'vegetables', 'de'), ('gemüse', 'vegetables', 'de'), ('vegetables', 'vegetables', 'en'), (' légumes', 'vegetables', 'fr'), ('verdura', 'vegetables', 'it'),
        ('schweinefleisch', 'pork', 'de'), ('pork', 'pork', 'en'), ('porc', 'pork', 'fr'),
        ('rindfleisch', 'beef', 'de'), ('beef', 'beef', 'en'), ('boeuf', 'beef', 'fr'),
        ('schaf', 'lamb', 'de'), ('lamb', 'lamb', 'en'), ('agneau', 'lamb', 'fr'),
        ('olivenöl', 'olive_oil', 'de'), ('olive oil', 'olive_oil', 'en'), ('huile d olive', 'olive_oil', 'fr');
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row: unknown) => (row as { version: number }).version)
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }

    db.exec(migration.up);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
  }
}
