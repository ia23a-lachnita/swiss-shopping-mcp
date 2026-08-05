/**
 * Score the relevance filter's recall over the captured pre-filter pools, and
 * optionally write the ratchet the gate compares against.
 *
 * Offline and deterministic — the pools are frozen fixtures, so this is a
 * measurement of our matcher and never of a vendor's afternoon.
 *
 *   node scripts/reportPoolRecall.mjs [--write-baseline] [--dropped <id>]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const poolDir = join(repoRoot, 'src', 'eval', 'fixtures-pool');
const baselinePath = join(repoRoot, 'src', 'eval', 'poolBaseline.json');

const { GOLDEN_QUERIES } = await import('../dist/eval/goldenSet.js');
const { scorePool, buildPoolReport } = await import('../dist/eval/poolRecall.js');

const droppedIndex = process.argv.indexOf('--dropped');
const droppedFor = droppedIndex >= 0 ? process.argv[droppedIndex + 1] : undefined;

const fixtures = new Map(
  readdirSync(poolDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const fixture = JSON.parse(readFileSync(join(poolDir, file), 'utf8'));
      return [fixture.id, fixture];
    })
);

const covered = GOLDEN_QUERIES.filter((query) => fixtures.has(query.id));
const report = buildPoolReport(covered.map((q) => scorePool(q, fixtures.get(q.id))));

const sorted = [...report.scores].sort((a, b) => a.recall - b.recall);
console.log('Recall of our own filter, per query (worst first):\n');
for (const score of sorted) {
  if (score.relevantInPool === 0) continue;
  const bar = '█'.repeat(Math.round(score.recall * 20)).padEnd(20, '·');
  console.log(
    `  ${score.id.padEnd(24)} ${bar} ${(score.recall * 100).toFixed(0).padStart(3)}%  ` +
      `kept ${String(score.relevantKept).padStart(3)}/${String(score.relevantInPool).padEnd(3)} relevant` +
      (score.forbiddenKept > 0 ? `  · ${score.forbiddenKept} forbidden kept` : '')
  );
}

const vacuous = report.scores.filter((s) => s.relevantInPool === 0).map((s) => s.id);
console.log(
  `\nMean recall: ${report.meanRecall}  ·  mean P@5 over the same pools: ${report.meanPrecisionAt5}`
);
console.log(`Wiped out (had relevant products, kept none): ${report.wipedOut.length}`);
if (report.wipedOut.length) console.log('  ' + report.wipedOut.join(', '));
console.log(`No labelled-relevant product in the pool at all: ${vacuous.length}`);
if (vacuous.length) console.log('  ' + vacuous.join(', '));

if (droppedFor) {
  const score = report.scores.find((s) => s.id === droppedFor);
  console.log(`\nDropped relevant products for "${droppedFor}" (${score.droppedRelevant.length}):`);
  for (const name of score.droppedRelevant) console.log(`  ${name}`);
}

if (process.argv.includes('--write-baseline')) {
  const floors = {};
  for (const score of report.scores) {
    // A query with nothing relevant in its pool scores a vacuous 1.0; freezing
    // that would gate on an empty shelf rather than on our filter.
    if (score.relevantInPool === 0) continue;
    // Rounded DOWN, never to nearest: the gate compares the raw ratio against
    // this number, so a floor rounded up (0.7857 -> 0.79) fails the build on
    // the very run that produced it.
    floors[score.id] = Math.floor(score.recall * 1000) / 1000;
  }
  writeFileSync(
    baselinePath,
    `${JSON.stringify(
      {
        _comment:
          'Recall of our own relevance filter over the pools in ./fixtures-pool, which are captured BEFORE the filter runs. Regenerate deliberately (node scripts/reportPoolRecall.mjs --write-baseline) and review the diff — a floor that falls means the matcher started discarding products it used to keep. Never re-baseline to make a red build green.',
        _floorsComment:
          'Per-query floors, so a change cannot raise the mean by helping easy queries while destroying one. Some floors are low because the LABELS are generous, not because the filter is wrong: ruebli counts Purina cat food with carrots as relevant, freilandeier counts any plain egg. Those are label defects to fix in goldenSet.ts, and raising the matcher to chase them would be optimising to a bad label.',
        meanRecall: report.meanRecall,
        floors,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  console.log(`\nWrote ${baselinePath}`);
}
