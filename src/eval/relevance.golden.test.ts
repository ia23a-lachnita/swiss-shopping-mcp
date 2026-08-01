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
const baselinePath = join(evalDir, 'baseline.json');

/**
 * Two tiers, scored separately.
 *
 * `vendor` is the raw fan-out. `web` adds the web-search augmentation, which
 * injects web-discovered products at the *head* of the merged list — ahead of
 * everything the adapters returned — so it can place a product in the top 5
 * that the vendor tier never saw. A gate that only covered the vendor tier
 * would be blind to exactly that.
 */
const TIERS = [
  { name: 'vendor', dir: join(evalDir, 'fixtures') },
  { name: 'web', dir: join(evalDir, 'fixtures-web') },
] as const;

interface Fixture {
  id: string;
  query: string;
  capturedAt: string;
  /** Web tier only: whether augmentation changed the pool vs the vendor tier. */
  augmented?: boolean;
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

function loadFixtures(dir: string): Map<string, Fixture> {
  if (!existsSync(dir)) return new Map();
  const entries = readdirSync(dir).filter((file) => file.endsWith('.json'));
  return new Map(
    entries.map((file) => {
      const fixture = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Fixture;
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

type TierBaseline = Baseline & { knownGateViolations: string[] };

const baselines = existsSync(baselinePath)
  ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as { tiers: Record<string, TierBaseline> }).tiers
  : {};

const presentTiers = TIERS.filter((tier) => loadFixtures(tier.dir).size > 0);

describe('search relevance tiers', () => {
  it('has the vendor tier captured', () => {
    // The vendor tier is mandatory: without it this file would pass by having
    // nothing to score, which is the failure mode it exists to prevent.
    expect(
      presentTiers.map((tier) => tier.name),
      'run npm run eval:capture'
    ).toContain('vendor');
  });

  it('only counts web-tier fixtures where augmentation actually contributed', () => {
    // A web fixture identical to its vendor counterpart means the provider was
    // rate-limited or unreachable at capture time. Committing it would report
    // coverage of the augmentation path while asserting nothing about it.
    const web = loadFixtures(TIERS[1].dir);
    const notAugmented = [...web.values()].filter((fixture) => fixture.augmented === false);
    expect(
      notAugmented.map((f) => f.id),
      're-capture with a healthy web-search provider, or drop these fixtures'
    ).toEqual([]);
  });
});

describe.each(presentTiers)('search relevance golden set — $name tier', ({ name, dir }) => {
  const fixtures = loadFixtures(dir);
  const covered = GOLDEN_QUERIES.filter((query) => fixtures.has(query.id));
  const baseline = baselines[name];

  const report: RelevanceReport = buildReport(
    covered.map((query) => scoreQuery(query, rankedFor(fixtures.get(query.id)!, query.query)))
  );

  it.skipIf(name !== 'vendor')('has a fixture for every golden query', () => {
    // Vendor tier only — the web tier is deliberately a subset (see
    // WEB_TIER_QUERY_IDS), because augmentation is rate-limited.
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
      `\n[${name}] Ranking (answered queries): P@5 ${report.precisionAt5} · MRR ${report.mrr} · n=${report.scored}` +
        `\n[${name}] End to end (all queries):  P@5 ${report.overallPrecisionAt5} · MRR ${report.overallMrr} · coverage ${report.coverage}` +
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
