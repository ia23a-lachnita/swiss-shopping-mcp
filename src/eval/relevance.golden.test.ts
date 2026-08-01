import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { NormalizedProduct } from '../adapters/types.js';
import { sortProducts } from '../util/matcher.js';
import { GOLDEN_QUERIES } from './goldenSet.js';
import {
  Baseline,
  RelevanceReport,
  ScoredProduct,
  buildReport,
  compareToBaseline,
  scoreQuery,
} from './relevanceScoring.js';

/**
 * Search-relevance gate.
 *
 * Runs the production ranking over frozen candidate pools captured from the
 * live vendor fan-out (`scripts/captureGoldenFixtures.mjs`), so the score moves
 * when the ranker moves and not when a vendor has a bad afternoon. No network.
 *
 * It is a **ratchet, not a target**: the corpus deliberately contains queries
 * that are broken today (the reported Milchdrink→Milchschokolade and
 * Protein Milch→bread defects). Those are listed in `baseline.json` as known
 * violations. A *new* violation fails the build, and so does a known violation
 * that has been fixed but not removed from the list — otherwise the allowlist
 * silently becomes permission to be wrong.
 */

const evalDir = fileURLToPath(new URL('.', import.meta.url));
const fixturesDir = join(evalDir, 'fixtures');
const baselinePath = join(evalDir, 'baseline.json');

interface Fixture {
  id: string;
  query: string;
  capturedAt: string;
  products: Array<{
    chain: string;
    name: string;
    brand: string | null;
    category: string | null;
    tags: string[];
    price: number | null;
    unit: string | null;
  }>;
}

function loadFixtures(): Map<string, Fixture> {
  if (!existsSync(fixturesDir)) return new Map();
  const entries = readdirSync(fixturesDir).filter((file) => file.endsWith('.json'));
  return new Map(
    entries.map((file) => {
      const fixture = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')) as Fixture;
      return [fixture.id, fixture];
    })
  );
}

/**
 * Rebuild the shape the ranker expects. Fields the ranker reads must be
 * carried faithfully — including `tags`, which is where ingredient text
 * reaches the matcher and causes the defects under test.
 */
function toNormalizedProduct(entry: Fixture['products'][number]): NormalizedProduct {
  return {
    id: `${entry.chain}:${entry.name}`,
    chain: entry.chain,
    name: entry.name,
    brand: entry.brand ?? undefined,
    category: entry.category ?? undefined,
    tags: entry.tags,
    price: { current: entry.price ?? 0, currency: 'CHF' },
    unit: entry.unit ?? undefined,
  } as NormalizedProduct;
}

function rankedFor(fixture: Fixture, query: string): ScoredProduct[] {
  return fixture.products
    .map(toNormalizedProduct)
    .sort((a, b) => sortProducts(a, b, query, 'balanced'))
    .map((product) => ({ chain: product.chain, name: product.name, brand: product.brand }));
}

const fixtures = loadFixtures();
const baseline = existsSync(baselinePath)
  ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline & { knownGateViolations: string[] })
  : undefined;

const covered = GOLDEN_QUERIES.filter((query) => fixtures.has(query.id));

describe.skipIf(covered.length === 0)('search relevance golden set', () => {
  const report: RelevanceReport = buildReport(
    covered.map((query) => scoreQuery(query, rankedFor(fixtures.get(query.id)!, query.query)))
  );

  it('has a fixture for every golden query', () => {
    const missing = GOLDEN_QUERIES.filter((query) => !fixtures.has(query.id)).map((q) => q.id);
    expect(missing, 'run scripts/captureGoldenFixtures.mjs').toEqual([]);
  });

  it('introduces no new top-5 violation on a gate query', () => {
    const known = new Set(baseline?.knownGateViolations ?? []);
    const introduced = report.gateViolations.filter((violation) => !known.has(violation.id));

    expect(
      introduced,
      `New relevance defects: ${introduced
        .map((v) => `"${v.id}" ranked "${v.name}" (${v.chain}) at #${v.rank}`)
        .join('; ')}`
    ).toEqual([]);
  });

  it('has no stale entry in the known-violation allowlist', () => {
    const stillViolating = new Set(report.gateViolations.map((violation) => violation.id));
    const fixed = (baseline?.knownGateViolations ?? []).filter((id) => !stillViolating.has(id));

    expect(
      fixed,
      `Fixed — remove from baseline.json knownGateViolations: ${fixed.join(', ')}`
    ).toEqual([]);
  });

  it('does not regress P@5 or MRR against the committed baseline', () => {
    if (!baseline) return;
    const verdict = compareToBaseline(report, baseline);
    expect(verdict.failures.join('; ')).toBe('');
  });

  it('reports the current scores for the record', () => {
    // Not an assertion — this prints the per-bucket breakdown so a reviewer can
    // see which linguistic class moved, which an aggregate number hides.
    // eslint-disable-next-line no-console -- the report is the point of this test
    console.log(
      `\nRanking (answered queries): P@5 ${report.precisionAt5} · MRR ${report.mrr} · n=${report.scored}` +
        `\nEnd to end (all queries):  P@5 ${report.overallPrecisionAt5} · MRR ${report.overallMrr} · coverage ${report.coverage}` +
        `\nBy bucket: ${Object.entries(report.byBucket)
          .map(([bucket, m]) => `${bucket} P@5 ${m.precisionAt5}/MRR ${m.mrr} (n=${m.queries})`)
          .join(' · ')}` +
        (report.emptyQueries.length ? `\nEmpty: ${report.emptyQueries.join(', ')}` : '') +
        (report.measureViolations.length
          ? `\nNon-gating violations: ${report.measureViolations
              .map((v) => `${v.id}→"${v.name}"@${v.rank}`)
              .join(', ')}`
          : '')
    );
    expect(report.scored).toBeGreaterThan(0);
  });
});
