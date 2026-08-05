import { GoldenQuery, QueryBucket } from './goldenSet.js';

/**
 * Scoring for the search-relevance golden set.
 *
 * Everything here is deliberately independent of `src/util/matcher.ts`. A
 * scorer that reused the matcher's own normalisation would move whenever the
 * ranker moved, and could never show the ranker getting worse.
 */

/**
 * Folds a product name or pattern to a comparable form: umlauts expanded the
 * way Swiss retailers actually spell them when they cannot type them
 * ("Rüebli"/"Rueebli", "Müesli"/"Muesli"), remaining diacritics stripped,
 * everything else collapsed to single spaces.
 *
 * Applied to patterns as well as names, so the corpus can be written in
 * natural spelling instead of pre-folded and easy to typo.
 */
export function foldForMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A candidate result, reduced to what relevance judgement is allowed to see.
 *
 * `category` and `tags` are deliberately absent rather than merely unused:
 * ingredient text reaches the matcher through tags, and a judge that could see
 * it would happily agree that a chocolate bar is milk. Making the field
 * unavailable means no future edit can quietly start reading it.
 */
export interface ScoredProduct {
  chain: string;
  name: string;
  brand?: string | null;
}

export type Judgement = 'relevant' | 'forbidden' | 'neutral';

/**
 * Judge one product against a query's labels.
 *
 * `forbidden` wins over `relevant` deliberately: "Milchschokolade" matches the
 * lemma `milch` and the pattern `schokolade`, and it is the wrong answer. A
 * label set where a product is both is a labelling bug, and resolving it
 * towards `forbidden` keeps the gate honest rather than quietly passing.
 */
/**
 * German inflectional endings a head noun may carry: "Banane"/"Bananen",
 * "Traube"/"Trauben". Without these the head rule below would reject a plural,
 * which is how half a grocery catalogue is written.
 */
const INFLECTION = '(?:e|en|er|n|s)?';

/** Patterns the corpus wrote as a bare word rather than as a regex. */
const PLAIN_WORD = /^[a-z0-9]+$/;

/**
 * In a German compound the **last** stem says what the thing is, and every
 * earlier stem only qualifies it. `Vollmilch` is a milk; `Milchschokolade` is a
 * chocolate. A substring test cannot tell those apart, and the corpus was being
 * scored by one — so for the query "Obst" it certified `Obstessig` (vinegar),
 * `Kernobstbranntwein` (schnapps) and a Dr. Beckmann *stain remover* as
 * relevant, and reported P@5 1.0 for a result list containing no fruit above
 * rank 3. The judge shared the matcher's substring assumption, which is exactly
 * why it could never see the matcher's substring defect.
 *
 * So a `relevant` pattern must land on a head: standalone, or ending the word.
 *
 * `forbidden` deliberately keeps the old anywhere-match, and the asymmetry is
 * the same piece of grammar read the other way round. "Is this a kind of X?"
 * is answered by the head; "does this carry trait Y at all?" is answered
 * anywhere in the compound — `Erdnussbutter` is forbidden for "Butter" *because
 * of* its modifier, and a head rule applied here would clear it.
 */
function patternMatcher(pattern: string): RegExp {
  const folded = foldForMatch(pattern);
  return PLAIN_WORD.test(folded) ? new RegExp(`${folded}${INFLECTION}\\b`) : new RegExp(folded);
}

export function judgeProduct(product: ScoredProduct, query: GoldenQuery): Judgement {
  // Identity fields only. Brand is required, not optional: Migros and Aldi put
  // the brand in `brand` and only the variant in `name`, so a Toblerone bar is
  // literally named "Crunchy Almond" and judging on name alone would score
  // every brand query near zero against results that are in fact correct.
  const identity = foldForMatch(`${product.name} ${product.brand ?? ''}`);

  if (query.forbidden.some((pattern) => new RegExp(foldForMatch(pattern)).test(identity))) {
    return 'forbidden';
  }
  if (query.relevant.some((pattern) => patternMatcher(pattern).test(identity))) return 'relevant';
  return 'neutral';
}

export interface QueryScore {
  id: string;
  bucket: QueryBucket;
  severity: GoldenQuery['severity'];
  /** Precision@5 over judged results: relevant / min(5, returned). */
  precisionAt5: number;
  /** Reciprocal rank of the first relevant result; 0 when none is found. */
  reciprocalRank: number;
  /** Forbidden products that reached the top 5 — the gate condition. */
  violations: Array<{ rank: number; chain: string; name: string }>;
  returned: number;
  /**
   * True when the query returned nothing at all. Kept separate from a score of
   * 0 because an empty result set is an availability problem, not a ranking
   * one, and averaging the two together hides both.
   */
  empty: boolean;
}

export const TOP_K = 5;

export function scoreQuery(query: GoldenQuery, results: ScoredProduct[]): QueryScore {
  const judged = results.map((product) => judgeProduct(product, query));
  const top = judged.slice(0, TOP_K);

  const relevantInTop = top.filter((j) => j === 'relevant').length;
  const firstRelevant = judged.findIndex((j) => j === 'relevant');

  const violations = results
    .slice(0, TOP_K)
    .map((product, index) => ({ product, index }))
    .filter(({ product }) => judgeProduct(product, query) === 'forbidden')
    .map(({ product, index }) => ({ rank: index + 1, chain: product.chain, name: product.name }));

  return {
    id: query.id,
    bucket: query.bucket,
    severity: query.severity,
    // Divided by the number actually returned, not a flat 5: a query with 3
    // results and 3 relevant ones scored 0.6 would be punished for the
    // catalogue's size rather than for its ranking.
    precisionAt5: top.length === 0 ? 0 : relevantInTop / top.length,
    reciprocalRank: firstRelevant === -1 ? 0 : 1 / (firstRelevant + 1),
    violations,
    returned: results.length,
    empty: results.length === 0,
  };
}

export interface RelevanceReport {
  /**
   * Mean P@5 over queries that returned something — the *ranking* signal, and
   * the one a ranker change should be judged by.
   *
   * Read it together with `coverage`: on its own it flatters the system,
   * because a query that returns nothing at all is silently excluded rather
   * than counted as the total failure it is for the user.
   */
  precisionAt5: number;
  /** Mean reciprocal rank over queries that returned something. */
  mrr: number;
  /**
   * The honest end-to-end numbers: every query counted, a zero-result query
   * scoring 0. This is what search quality actually is from the user's side.
   */
  overallPrecisionAt5: number;
  overallMrr: number;
  /** Share of queries that returned at least one result. */
  coverage: number;
  /** Per-bucket means, so easy buckets cannot mask hard ones. */
  byBucket: Record<string, { precisionAt5: number; mrr: number; queries: number }>;
  /** Every gate-severity violation, which is what fails a build. */
  gateViolations: Array<{ id: string; rank: number; chain: string; name: string }>;
  /** Violations on measure-severity queries — reported, not fatal. */
  measureViolations: Array<{ id: string; rank: number; chain: string; name: string }>;
  emptyQueries: string[];
  scored: number;
  scores: QueryScore[];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function buildReport(scores: QueryScore[]): RelevanceReport {
  const nonEmpty = scores.filter((score) => !score.empty);

  const byBucket: RelevanceReport['byBucket'] = {};
  for (const score of nonEmpty) {
    const bucket = (byBucket[score.bucket] ??= { precisionAt5: 0, mrr: 0, queries: 0 });
    bucket.queries += 1;
  }
  for (const bucket of Object.keys(byBucket)) {
    const inBucket = nonEmpty.filter((score) => score.bucket === bucket);
    byBucket[bucket].precisionAt5 = round(mean(inBucket.map((s) => s.precisionAt5)));
    byBucket[bucket].mrr = round(mean(inBucket.map((s) => s.reciprocalRank)));
  }

  const violationsOf = (severity: GoldenQuery['severity']): RelevanceReport['gateViolations'] =>
    scores
      .filter((score) => score.severity === severity)
      .flatMap((score) => score.violations.map((violation) => ({ id: score.id, ...violation })));

  return {
    precisionAt5: round(mean(nonEmpty.map((s) => s.precisionAt5))),
    mrr: round(mean(nonEmpty.map((s) => s.reciprocalRank))),
    // Empty queries score 0 here rather than being skipped: from the user's
    // side "no results" is not an absent measurement, it is a failed search.
    overallPrecisionAt5: round(mean(scores.map((s) => s.precisionAt5))),
    overallMrr: round(mean(scores.map((s) => s.reciprocalRank))),
    coverage: scores.length === 0 ? 0 : round(nonEmpty.length / scores.length),
    byBucket,
    gateViolations: violationsOf('gate'),
    measureViolations: violationsOf('measure'),
    emptyQueries: scores.filter((score) => score.empty).map((score) => score.id),
    scored: nonEmpty.length,
    scores,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface Baseline {
  precisionAt5: number;
  mrr: number;
  /**
   * Answer rate. Gated in its own right: a query-understanding change that
   * silently stops matching a whole class of queries would otherwise *raise*
   * the ranking metrics, by removing the hard queries from the average.
   */
  coverage: number;
  /**
   * How far a metric may fall below the baseline before the build fails.
   * Non-zero because the fixtures carry a handful of near-ties whose order is
   * not fully determined; zero tolerance would fail on noise, and a suite that
   * fails on noise gets disabled.
   */
  tolerance: number;
}

export interface BaselineVerdict {
  ok: boolean;
  failures: string[];
}

export function compareToBaseline(report: RelevanceReport, baseline: Baseline): BaselineVerdict {
  const failures: string[] = [];

  if (report.precisionAt5 < baseline.precisionAt5 - baseline.tolerance) {
    failures.push(
      `P@5 regressed: ${report.precisionAt5} < ${baseline.precisionAt5} - ${baseline.tolerance}`
    );
  }
  if (report.mrr < baseline.mrr - baseline.tolerance) {
    failures.push(`MRR regressed: ${report.mrr} < ${baseline.mrr} - ${baseline.tolerance}`);
  }
  if (report.coverage < baseline.coverage - baseline.tolerance) {
    failures.push(
      `Coverage regressed: ${report.coverage} < ${baseline.coverage} - ${baseline.tolerance}`
    );
  }

  return { ok: failures.length === 0, failures };
}
