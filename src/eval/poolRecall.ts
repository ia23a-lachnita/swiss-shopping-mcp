import { MatchMode, NormalizedProduct } from '../adapters/types.js';
import { calculateMatchStrength, sortProducts } from '../util/matcher.js';
import { GoldenQuery } from './goldenSet.js';
import { TOP_K, judgeProduct } from './relevanceScoring.js';

/**
 * Recall of our own relevance filter, measured against the pool the vendors
 * actually returned.
 *
 * The precision gate (`relevance.golden.test.ts`) scores fixtures captured
 * *after* `productMatches` has run, so every product this project wrongly
 * discards is missing from its input. It reported P@5 0.98 on a system that was
 * throwing away 45.4% of everything the vendors returned — including all
 * fourteen Migros pastas for the query "Teigwaren" — because a metric cannot
 * measure what it is never shown. That is not an argument against fixtures: it
 * is an argument against capturing them downstream of the thing under test.
 *
 * So this scores the same decision from the other side. The pool fixtures
 * (`fixtures-pool/`, captured with `eval:capture -- --pool`) hold both sides of
 * the filter's verdict, and every product is re-judged here by the golden set's
 * own labels — never by the matcher, which would make the measurement agree
 * with whatever the matcher currently does.
 */

/** One candidate as the vendors returned it, before our filter saw it. */
export interface PoolProduct {
  chain: string;
  name: string;
  brand?: string | null;
  category?: string | null;
  tags?: string[];
  price?: number | null;
  /** The filter's verdict on the day of capture. Never read by scoring. */
  keptAtCapture?: boolean;
}

export interface PoolFixture {
  id: string;
  query: string;
  capturedAt: string;
  pool: PoolProduct[];
}

export interface PoolRecallScore {
  id: string;
  /** Products in the pool the golden labels call relevant — the denominator. */
  relevantInPool: number;
  /** How many of those the current filter keeps. */
  relevantKept: number;
  /**
   * `relevantKept / relevantInPool`, or 1 when the vendors returned nothing
   * relevant at all: a query the vendors cannot answer is a coverage problem,
   * and scoring it 0 here would blame the filter for an empty shelf.
   */
  recall: number;
  /** Everything the filter keeps, relevant or not — the precision denominator. */
  kept: number;
  /** Kept products the labels explicitly forbid. Junk the filter let through. */
  forbiddenKept: number;
  /**
   * P@5 over the surviving pool, ranked by the production sort.
   *
   * The precision gate cannot answer this for a change that *keeps more*: its
   * fixtures were captured through the old filter, so a product newly admitted
   * is absent from them and its effect on the top 5 is unmeasurable there. Here
   * the pool holds both sides, so loosening the filter and ranking the result
   * are scored on the same frozen data — recall bought and precision paid, in
   * one run.
   */
  precisionAt5: number;
  /** Named, because a count alone is unreviewable in a diff. */
  droppedRelevant: string[];
}

function asProduct(candidate: PoolProduct): NormalizedProduct {
  // Only the fields the matcher reads. Cast rather than fabricate a whole
  // product: inventing a price or a store here would be inventing evidence.
  return {
    chain: candidate.chain,
    name: candidate.name,
    brand: candidate.brand ?? undefined,
    category: candidate.category ?? undefined,
    tags: candidate.tags ?? [],
    price: { current: candidate.price ?? 0, currency: 'CHF' },
  } as unknown as NormalizedProduct;
}

/**
 * Mirrors `productMatches`: a product survives when it scores above zero. The
 * price and filter checks around it in the adapter are deliberately not
 * reproduced — this measures the relevance decision, and nothing else.
 */
export function survivesFilter(
  candidate: PoolProduct,
  query: string,
  matchMode: MatchMode = 'balanced'
): boolean {
  return calculateMatchStrength(asProduct(candidate), query, matchMode) > 0;
}

export function scorePool(query: GoldenQuery, fixture: PoolFixture): PoolRecallScore {
  let relevantInPool = 0;
  let relevantKept = 0;
  let kept = 0;
  let forbiddenKept = 0;
  const droppedRelevant: string[] = [];
  const survivors: PoolProduct[] = [];

  for (const candidate of fixture.pool) {
    const judgement = judgeProduct(
      { chain: candidate.chain, name: candidate.name, brand: candidate.brand },
      query
    );
    const survives = survivesFilter(candidate, query.query);

    if (survives) {
      kept += 1;
      survivors.push(candidate);
      if (judgement === 'forbidden') forbiddenKept += 1;
    }
    if (judgement !== 'relevant') continue;

    relevantInPool += 1;
    if (survives) relevantKept += 1;
    else droppedRelevant.push(`${candidate.chain}|${candidate.name}`);
  }

  const topFive = survivors
    .map(asProduct)
    .sort((a, b) => sortProducts(a, b, query.query, 'balanced'))
    .slice(0, TOP_K);
  const relevantInTop = topFive.filter(
    (product) =>
      judgeProduct({ chain: product.chain, name: product.name, brand: product.brand }, query) ===
      'relevant'
  ).length;

  return {
    id: query.id,
    relevantInPool,
    relevantKept,
    recall: relevantInPool === 0 ? 1 : relevantKept / relevantInPool,
    kept,
    forbiddenKept,
    precisionAt5: topFive.length === 0 ? 0 : relevantInTop / topFive.length,
    droppedRelevant,
  };
}

export interface PoolRecallReport {
  /** Mean P@5 over the same frozen pools — the price paid for the recall. */
  meanPrecisionAt5: number;
  /**
   * Mean of the per-query recalls, not the pooled ratio.
   *
   * A pooled ratio would let one query with a huge pool set the number for the
   * whole set — "Teigwaren" alone carries 134 candidates — and a per-query mean
   * is what per-query floors are compared against anyway.
   */
  meanRecall: number;
  /** Queries whose relevant products were entirely discarded. */
  wipedOut: string[];
  scores: PoolRecallScore[];
}

export function buildPoolReport(scores: PoolRecallScore[]): PoolRecallReport {
  const mean = (pick: (score: PoolRecallScore) => number): number =>
    scores.length === 0 ? 0 : Math.round((scores.reduce((sum, s) => sum + pick(s), 0) / scores.length) * 1000) / 1000;

  return {
    meanPrecisionAt5: mean((s) => s.precisionAt5),
    meanRecall: mean((s) => s.recall),
    wipedOut: scores.filter((s) => s.relevantInPool > 0 && s.relevantKept === 0).map((s) => s.id),
    scores,
  };
}
