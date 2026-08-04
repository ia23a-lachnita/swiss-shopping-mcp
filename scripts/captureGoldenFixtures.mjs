/**
 * Capture the merged candidate pool for every golden query against the live
 * vendor fan-out, so the relevance suite can score a ranker deterministically
 * without hitting the network.
 *
 * Run from the repo root after `npm run build`:
 *   node scripts/captureGoldenFixtures.mjs [--only <id>[,<id>...]] [--web]
 *
 * Two tiers:
 *   default  raw vendor fan-out          -> src/eval/fixtures/
 *   --web    plus web-search augmentation -> src/eval/fixtures-web/
 *
 * The web tier exists because augmentation injects web-discovered products at
 * the *head* of the merged list, ahead of everything the adapters returned, so
 * it can put a product in the top 5 that the vendor tier never saw. It needs
 * provider API keys in the environment.
 *
 * The local SQLite catalog is deliberately excluded from both tiers: its
 * contents are environment-specific (a few hundred rows here, a different set
 * on the Pi), so fixtures captured against it would not be reproducible.
 *
 * Fixtures are snapshots of a live catalogue and WILL drift. Re-capture
 * deliberately (and review the diff), never automatically as part of a test
 * run — a fixture silently re-recorded to match new behaviour proves nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const withWeb = process.argv.includes('--web');
const outDir = join(repoRoot, 'src', 'eval', withWeb ? 'fixtures-web' : 'fixtures');

const { createDefaultAdapters } = await import('../dist/adapters/index.js');
const { SearchService } = await import('../dist/services/searchService.js');
const { createDefaultWebProductSearch } = await import(
  '../dist/services/webProductSearchService.js'
);
const { GOLDEN_QUERIES, WEB_TIER_QUERY_IDS } = await import('../dist/eval/goldenSet.js');

// Comma-separated, because the honest way to re-capture after a change to
// query understanding is to re-capture exactly the queries that change and
// leave the rest frozen — otherwise vendor drift lands in the same diff and
// nobody can tell which moved the numbers.
const onlyIndex = process.argv.indexOf('--only');
const only =
  onlyIndex >= 0
    ? new Set(
        (process.argv[onlyIndex + 1] ?? '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      )
    : undefined;

const adapters = createDefaultAdapters();
let webProductSearch;
if (withWeb) {
  webProductSearch = createDefaultWebProductSearch(adapters, {});
  if (!webProductSearch) {
    console.error(
      'Web search unavailable — set a provider key (and do not set SWISS_SHOPPING_WEB_SEARCH=off).'
    );
    process.exit(1);
  }
}
// No breaker and no cache in either tier: the fixture must be the candidate
// pool the adapters actually produced, not a cache artefact.
const service = new SearchService(adapters, { webProductSearch });
console.log(withWeb ? 'Tier: vendor + web augmentation' : 'Tier: raw vendor fan-out');

mkdirSync(outDir, { recursive: true });

const inScope = withWeb
  ? GOLDEN_QUERIES.filter((q) => WEB_TIER_QUERY_IDS.includes(q.id))
  : GOLDEN_QUERIES;
const queries = only ? inScope.filter((q) => only.has(q.id)) : inScope;
console.log(`Capturing ${queries.length} queries...`);

/** Read the vendor-tier pool so the web tier can tell whether augmentation actually did anything. */
function vendorPool(id) {
  const path = join(repoRoot, 'src', 'eval', 'fixtures', `${id}.json`);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')).products.map((p) => `${p.chain}|${p.name}`).join(',');
}

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

  // Whether augmentation actually contributed, recorded per fixture. Without
  // this the web tier degrades into a copy of the vendor tier the moment the
  // provider is rate-limited or its breaker opens, and nothing says so.
  const augmented = withWeb
    ? products.map((p) => `${p.chain}|${p.name}`).join(',') !== vendorPool(golden.id)
    : undefined;

  console.log(
    error
      ? `ERROR ${error}`
      : `${products.length} products (${elapsed}ms)${withWeb ? (augmented ? ' [augmented]' : ' [NOT augmented]') : ''}`
  );

  writeFileSync(
    join(outDir, `${golden.id}.json`),
    `${JSON.stringify(
      { id: golden.id, query: golden.query, capturedAt: new Date().toISOString(), augmented, products },
      null,
      2
    )}\n`,
    'utf8'
  );
  summary.push({ id: golden.id, count: products.length, error, augmented });
}

const empty = summary.filter((s) => s.count === 0);
console.log(`\nCaptured ${summary.length} fixtures; ${empty.length} empty.`);
if (empty.length) console.log('Empty:', empty.map((s) => s.id).join(', '));

if (withWeb) {
  const notAugmented = summary.filter((s) => !s.augmented).map((s) => s.id);
  if (notAugmented.length > 0) {
    console.log(
      `\nWARNING: web augmentation contributed nothing for ${notAugmented.length}/${summary.length}: ${notAugmented.join(', ')}` +
        `\nThe provider is probably rate-limited or its circuit breaker is open (it opens after 3` +
        `\nfailures and stays open 5 minutes). Wait and re-capture those ids — committing them as` +
        `\nthey are records vendor-only pools in the web tier and asserts nothing.`
    );
  }
}
process.exit(0);
