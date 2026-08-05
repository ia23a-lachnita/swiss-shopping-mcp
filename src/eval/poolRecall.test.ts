import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GOLDEN_QUERIES } from './goldenSet.js';
import { PoolFixture, buildPoolReport, scorePool } from './poolRecall.js';

/**
 * Recall gate: what our relevance filter throws away.
 *
 * The sibling gate (`relevance.golden.test.ts`) scores ranking over fixtures
 * captured *after* the filter ran, and is therefore structurally incapable of
 * seeing a product the filter wrongly dropped. It reported P@5 0.98 while the
 * filter was discarding 45.4% of everything the vendors returned. This file
 * scores the same fan-out from the other side, over pools captured one step
 * earlier (`npm run eval:capture -- --pool`).
 *
 * A ratchet, like its sibling: the floors below are what the system does today,
 * not what it should do. Raising them is the work; lowering one is a decision
 * that has to be argued for in the diff.
 */

const evalDir = fileURLToPath(new URL('.', import.meta.url));
const poolDir = join(evalDir, 'fixtures-pool');
const baselinePath = join(evalDir, 'poolBaseline.json');

interface PoolBaseline {
  meanRecall: number;
  /**
   * Per-query floors, so a change cannot raise the mean by helping easy queries
   * while destroying one. Queries whose pool holds nothing relevant are absent:
   * they score a vacuous 1.0 and would freeze an empty shelf into the gate.
   */
  floors: Record<string, number>;
}

function loadPool(): Map<string, PoolFixture> {
  if (!existsSync(poolDir)) return new Map();
  return new Map(
    readdirSync(poolDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        const fixture = JSON.parse(readFileSync(join(poolDir, file), 'utf8')) as PoolFixture;
        return [fixture.id, fixture];
      })
  );
}

const fixtures = loadPool();
const baseline: PoolBaseline | undefined = existsSync(baselinePath)
  ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as PoolBaseline)
  : undefined;

describe.skipIf(fixtures.size === 0)('relevance filter recall', () => {
  const covered = GOLDEN_QUERIES.filter((query) => fixtures.has(query.id));
  const report = buildPoolReport(
    covered.map((query) => scorePool(query, fixtures.get(query.id)!))
  );

  it('has a baseline to ratchet against', () => {
    expect(baseline, 'run scripts/reportPoolRecall.mjs and commit the numbers').toBeDefined();
  });

  it('does not regress mean recall', () => {
    // No tolerance: the fixtures are frozen and the score is an exact ratio, so
    // unlike the ranking gate there are no near-ties to jitter it.
    expect(report.meanRecall).toBeGreaterThanOrEqual(baseline?.meanRecall ?? 0);
  });

  it('does not regress any single query below its floor', () => {
    const fallen = report.scores
      .filter((score) => score.recall < (baseline?.floors[score.id] ?? 0))
      .map(
        (score) =>
          `${score.id}: ${score.recall.toFixed(2)} < ${baseline?.floors[score.id]?.toFixed(2)}` +
          ` (dropped ${score.droppedRelevant.slice(0, 3).join(', ')})`
      );

    expect(fallen, 'the filter started discarding products it used to keep').toEqual([]);
  });

  it('never discards every relevant product a vendor returned', () => {
    // The worst shape of this defect and the one a mean hides: the shelf is
    // full, the user sees nothing, and every other metric still looks healthy.
    expect(
      report.wipedOut,
      'these queries had relevant products in the vendor pool and kept none of them'
    ).toEqual([]);
  });
});
