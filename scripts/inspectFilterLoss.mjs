/**
 * Read what the filter threw away, instead of counting it.
 *
 * `measureFilterLoss.mjs` established the size of the loss (45.4% of everything
 * the vendors returned). It cannot say whether that is a defect: discarding
 * loosely-related products is exactly this predicate's job. This script prints
 * the product names on both sides of the decision for one query at a time, so
 * the rejections can be read and judged.
 *
 * The fixtures cannot answer this — they are captured after the filter runs, so
 * the rejected products are already gone from the snapshot. It has to be live.
 *
 * Run from the repo root after `npm run build`:
 *   node scripts/inspectFilterLoss.mjs <queryId>[,<queryId>...] [--all]
 *
 * `--all` prints every rejection; the default prints the first 25 per query.
 */
const { createDefaultAdapters } = await import('../dist/adapters/index.js');
const { SearchService } = await import('../dist/services/searchService.js');
const { matchDiagnostics } = await import('../dist/adapters/live/baseLiveAdapter.js');
const { GOLDEN_QUERIES } = await import('../dist/eval/goldenSet.js');

const ids = new Set(
  (process.argv[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
);
const showAll = process.argv.includes('--all');
if (ids.size === 0) {
  console.error('usage: node scripts/inspectFilterLoss.mjs <queryId>[,<queryId>...] [--all]');
  console.error('known ids: ' + GOLDEN_QUERIES.map((q) => q.id).join(', '));
  process.exit(1);
}

matchDiagnostics.enabled = true;
matchDiagnostics.collectSamples = true;
const service = new SearchService(createDefaultAdapters());

const label = (s) =>
  [s.name, s.brand ? `[${s.brand}]` : '', s.category ? `(${s.category})` : '']
    .filter(Boolean)
    .join(' ');

for (const golden of GOLDEN_QUERIES.filter((q) => ids.has(q.id))) {
  matchDiagnostics.reset();
  try {
    await service.searchProducts({ query: golden.query, limit: 40 });
  } catch (error) {
    console.log(`  (fan-out threw: ${error instanceof Error ? error.message : String(error)})`);
  }

  const rejected = [...matchDiagnostics.rejected];
  const kept = [...matchDiagnostics.kept];
  console.log(
    `\n=== ${golden.id} — "${golden.query}" — kept ${kept.length}, rejected ${rejected.length}`
  );

  const byChain = new Map();
  for (const sample of rejected) {
    if (!byChain.has(sample.chain)) byChain.set(sample.chain, []);
    byChain.get(sample.chain).push(sample);
  }

  console.log(`  KEPT (passed the relevance gate):`);
  for (const sample of showAll ? kept : kept.slice(0, 10)) {
    console.log(`    ${sample.chain.padEnd(8)} ${label(sample)}`);
  }
  if (!showAll && kept.length > 10) console.log(`    … ${kept.length - 10} more`);

  for (const [chain, samples] of [...byChain].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  REJECTED — ${chain} (${samples.length}):`);
    for (const sample of showAll ? samples : samples.slice(0, 25)) {
      console.log(`    ${label(sample)}`);
    }
    if (!showAll && samples.length > 25) console.log(`    … ${samples.length - 25} more`);
  }
}
process.exit(0);
