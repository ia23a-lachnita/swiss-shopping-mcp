/**
 * How much of "vendor search is bad" is actually our own filter?
 *
 * For every golden query, run the real fan-out and tally, per chain, how many
 * products the vendor returned and how many `productMatches` then discarded.
 * The two causes are indistinguishable from the outside — both end as a thin
 * result list — but they want opposite responses: one is fixed by indexing the
 * vendor ourselves, the other by fixing our matcher. We already have one hard
 * data point that it can be entirely ours ("Milchdrink UHT": Migros returned 12,
 * we rejected 12), and this is the measurement that says how typical that is.
 *
 * Run from the repo root after `npm run build`:
 *   node scripts/measureFilterLoss.mjs [--only <id>[,<id>...]]
 */
const { createDefaultAdapters } = await import('../dist/adapters/index.js');
const { SearchService } = await import('../dist/services/searchService.js');
const { matchDiagnostics } = await import('../dist/adapters/live/baseLiveAdapter.js');
const { GOLDEN_QUERIES } = await import('../dist/eval/goldenSet.js');

const onlyIndex = process.argv.indexOf('--only');
const only =
  onlyIndex >= 0
    ? new Set((process.argv[onlyIndex + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean))
    : undefined;

matchDiagnostics.enabled = true;
const service = new SearchService(createDefaultAdapters());
const queries = only ? GOLDEN_QUERIES.filter((q) => only.has(q.id)) : GOLDEN_QUERIES;

const totals = new Map();
const perQuery = [];

for (const golden of queries) {
  matchDiagnostics.reset();
  let returned = 0;
  try {
    const result = await service.searchProducts({ query: golden.query, limit: 40 });
    returned = (result.data ?? []).length;
  } catch {
    // A dead chain is not what this measures; the tally below still stands.
  }

  let seen = 0;
  let rejected = 0;
  for (const [chain, row] of matchDiagnostics.byChain) {
    seen += row.seen;
    rejected += row.rejectedRelevance;
    const t = totals.get(chain) ?? { seen: 0, rejectedRelevance: 0, rejectedPrice: 0 };
    t.seen += row.seen;
    t.rejectedRelevance += row.rejectedRelevance;
    t.rejectedPrice += row.rejectedPrice;
    totals.set(chain, t);
  }

  const loss = seen > 0 ? rejected / seen : 0;
  perQuery.push({ id: golden.id, seen, rejected, returned, loss });
  console.log(
    `  ${golden.id.padEnd(26)} vendors returned ${String(seen).padStart(4)} · we rejected ${String(
      rejected
    ).padStart(4)} (${(loss * 100).toFixed(0).padStart(3)}%) · final ${returned}`
  );
}

console.log('\nPer chain (relevance rejections only):');
for (const [chain, t] of [...totals].sort((a, b) => b[1].seen - a[1].seen)) {
  const pct = t.seen > 0 ? (t.rejectedRelevance / t.seen) * 100 : 0;
  console.log(
    `  ${chain.padEnd(8)} returned ${String(t.seen).padStart(5)} · rejected ${String(
      t.rejectedRelevance
    ).padStart(5)} (${pct.toFixed(0)}%)`
  );
}

// The queries where we threw away everything the vendors had are the ones that
// look like "the vendor has nothing" and are in fact entirely self-inflicted.
const total = perQuery.reduce((a, q) => a + q.seen, 0);
const rejected = perQuery.reduce((a, q) => a + q.rejected, 0);
const wipedOut = perQuery.filter((q) => q.seen > 0 && q.rejected === q.seen);
const starved = perQuery.filter((q) => q.seen === 0);

console.log(
  `\nOverall: vendors returned ${total}, we rejected ${rejected} (${((rejected / total) * 100).toFixed(1)}%).`
);
console.log(`Queries where we discarded EVERYTHING the vendors returned: ${wipedOut.length}/${perQuery.length}`);
if (wipedOut.length) console.log('  ' + wipedOut.map((q) => q.id).join(', '));
console.log(`Queries where vendors genuinely returned nothing: ${starved.length}/${perQuery.length}`);
if (starved.length) console.log('  ' + starved.map((q) => q.id).join(', '));
process.exit(0);
