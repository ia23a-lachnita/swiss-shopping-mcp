/**
 * Capture the merged candidate pool for every golden query against the live
 * vendor fan-out, so the relevance suite can score a ranker deterministically
 * without hitting the network.
 *
 * Run from the repo root after `npm run build`:
 *   node scripts/captureGoldenFixtures.mjs [--only <queryId>]
 *
 * Fixtures are snapshots of a live catalogue and WILL drift. Re-capture
 * deliberately (and review the diff), never automatically as part of a test
 * run — a fixture silently re-recorded to match new behaviour proves nothing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const outDir = join(repoRoot, 'src', 'eval', 'fixtures');

const { createDefaultAdapters } = await import('../dist/adapters/index.js');
const { SearchService } = await import('../dist/services/searchService.js');
const { GOLDEN_QUERIES } = await import('../dist/eval/goldenSet.js');

const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined;

const adapters = createDefaultAdapters();
// No catalog, no web augmentation, no breaker/cache: the fixture must be the
// raw vendor candidate pool, not a cache artefact.
const service = new SearchService(adapters);

mkdirSync(outDir, { recursive: true });

const queries = only ? GOLDEN_QUERIES.filter((q) => q.id === only) : GOLDEN_QUERIES;
console.log(`Capturing ${queries.length} queries...`);

const summary = [];

for (const golden of queries) {
  process.stdout.write(`  ${golden.id.padEnd(28)} `);
  const started = Date.now();
  let products = [];
  let error;
  try {
    const result = await service.searchProducts({ query: golden.query, limit: 40 });
    products = (result.data ?? []).map((p) => ({
      chain: p.chain,
      name: p.name,
      brand: p.brand ?? null,
      category: p.category ?? null,
      tags: p.tags ?? [],
      price: p.price?.current ?? null,
      unit: p.unit ?? null,
    }));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const elapsed = Date.now() - started;
  console.log(error ? `ERROR ${error}` : `${products.length} products (${elapsed}ms)`);

  writeFileSync(
    join(outDir, `${golden.id}.json`),
    `${JSON.stringify({ id: golden.id, query: golden.query, capturedAt: new Date().toISOString(), products }, null, 2)}\n`,
    'utf8'
  );
  summary.push({ id: golden.id, count: products.length, error });
}

const empty = summary.filter((s) => s.count === 0);
console.log(`\nCaptured ${summary.length} fixtures; ${empty.length} empty.`);
if (empty.length) console.log('Empty:', empty.map((s) => s.id).join(', '));
process.exit(0);
