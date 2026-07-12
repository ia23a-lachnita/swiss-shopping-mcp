import Database from 'better-sqlite3';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function resolveDbPath(env?: NodeJS.ProcessEnv): string {
  const e = env ?? process.env;
  if (e.SWISS_SHOPPING_DB_PATH) {
    return e.SWISS_SHOPPING_DB_PATH;
  }
  const cacheDir =
    e.SWISS_SHOPPING_CACHE_DIR ?? join(tmpdir(), 'swiss-shopping-mcp-cache');
  return join(cacheDir, 'catalog.sqlite3');
}

export function openCatalogDb(dbPath?: string, env?: NodeJS.ProcessEnv): Database.Database {
  const resolvedPath = dbPath ?? resolveDbPath(env);
  const db = new Database(resolvedPath);

  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  return db;
}
