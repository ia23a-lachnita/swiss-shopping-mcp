export { CatalogService } from './catalogService.js';
export { openCatalogDb, resolveDbPath } from './db.js';
export { runMigrations } from './migrations.js';
export { normalizeQuery, expandWithSynonyms } from './queryNormalizer.js';
export type {
  CatalogPriceHistory,
  CatalogProduct,
  CatalogSearchResult,
  CatalogStats,
  ProductObservation,
  ProductStatus,
} from './types.js';
