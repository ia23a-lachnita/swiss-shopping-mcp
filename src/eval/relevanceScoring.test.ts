import { describe, expect, it } from 'vitest';

import { GoldenQuery } from './goldenSet.js';
import {
  buildReport,
  compareToBaseline,
  foldForMatch,
  judgeProduct,
  scoreQuery,
} from './relevanceScoring.js';

/**
 * The scorer is the instrument, so it is tested independently of the corpus it
 * scores. A silently wrong instrument would make every relevance number in CI
 * meaningless while looking perfectly green.
 */

function query(overrides: Partial<GoldenQuery> = {}): GoldenQuery {
  return {
    id: 'test',
    query: 'Milch',
    bucket: 'compound',
    relevant: ['milch'],
    forbidden: ['schokolade'],
    severity: 'measure',
    ...overrides,
  };
}

const product = (name: string, chain = 'migros'): { chain: string; name: string } => ({ chain, name });

describe('foldForMatch', () => {
  it('expands umlauts the way Swiss retailers spell around them', () => {
    expect(foldForMatch('Rüebli')).toBe('rueebli');
    expect(foldForMatch('Müesli')).toBe('mueesli');
    expect(foldForMatch('Käse')).toBe('kaese');
  });

  it('folds ß and strips remaining diacritics', () => {
    expect(foldForMatch('Weißmehl')).toBe('weissmehl');
    expect(foldForMatch('Caffè Latte')).toBe('caffe latte');
  });

  it('collapses whitespace and case', () => {
    expect(foldForMatch('  Bio   VOLLMILCH ')).toBe('bio vollmilch');
  });
});

describe('judgeProduct', () => {
  it('marks a product matching a relevant pattern', () => {
    expect(judgeProduct(product('Vollmilch UHT'), query())).toBe('relevant');
  });

  it('marks a product matching no pattern as neutral', () => {
    expect(judgeProduct(product('Rüebli'), query())).toBe('neutral');
  });

  it('lets forbidden win over relevant', () => {
    // "Milchschokolade" matches both `milch` and `schokolade`. Resolving
    // towards forbidden is what makes the gate trustworthy.
    expect(judgeProduct(product('Milchschokolade'), query())).toBe('forbidden');
  });

  it('credits a match carried by the brand field alone', () => {
    // Migros names this product "Crunchy Almond" and puts "Toblerone" in
    // `brand`; judging on the name alone scored real brand hits as misses.
    const result = judgeProduct(
      { chain: 'migros', name: 'Crunchy Almond', brand: 'Toblerone' },
      query({ relevant: ['toblerone'] })
    );
    expect(result).toBe('relevant');
  });

  it('cannot see category or ingredient text', () => {
    // Structural, not behavioural: ScoredProduct carries no tags/category, so
    // a chocolate bar whose ingredients list milk can never be judged relevant
    // to a milk query on that basis.
    const scored: Record<string, unknown> = { chain: 'coop', name: 'Milchschokolade' };
    expect(Object.keys(scored)).not.toContain('tags');
    expect(judgeProduct(scored as never, query())).toBe('forbidden');
  });

  it('matches patterns written with natural umlaut spelling', () => {
    expect(judgeProduct(product('Rüebli Bio'), query({ relevant: ['rüebli'] }))).toBe('relevant');
  });

  it('credits a relevant pattern only where it heads the compound', () => {
    // The head of a German compound says what the thing is. `Vollmilch` is a
    // milk; `Milchschokolade` is a chocolate. Scoring both as milk is how the
    // corpus came to certify vinegar, schnapps and a stain remover as fruit for
    // the query "Obst", and report P@5 1.0 for it.
    const fruit = query({ id: 'obst', query: 'Obst', relevant: ['obst'], forbidden: [] });
    expect(judgeProduct(product('Bio Obst Mix'), fruit)).toBe('relevant');
    expect(judgeProduct(product('Naturaplan Bio Demeter Obstessig'), fruit)).toBe('neutral');
    expect(judgeProduct(product('Kernobstbranntwein'), fruit)).toBe('neutral');
    // This line used to assert 'relevant', with the comment "standalone word,
    // and beyond what an identity-only judge can rule out". That was an honest
    // record of a limitation, and the limitation is now gone: the head rule
    // genuinely cannot see this one, because "Obst" is a standalone word here
    // rather than a modifier — but a *macro-domain* rule can, since the thing
    // is a stain remover and says so in its own name.
    expect(
      judgeProduct(product('Dr. Beckmann Fleckenentferner Obst & Getränke'), fruit)
    ).toBe('neutral');
  });

  it('still credits an inflected head', () => {
    // Rejecting a plural would reject half a grocery catalogue.
    const fruit = query({ relevant: ['banane', 'traube'], forbidden: [] });
    expect(judgeProduct(product('Chiquita Bananen'), fruit)).toBe('relevant');
    expect(judgeProduct(product('Weisse Trauben'), fruit)).toBe('relevant');
  });

  it('keeps forbidden patterns matching anywhere in a compound', () => {
    // Deliberately not the head rule: "is this a kind of X" is answered by the
    // head, "does it carry trait Y at all" by any position. Erdnussbutter is
    // forbidden for "Butter" precisely because of its modifier.
    const butter = query({ query: 'Butter', relevant: ['butter'], forbidden: ['erdnuss'] });
    expect(judgeProduct(product('Erdnussbutter Crunchy'), butter)).toBe('forbidden');
  });
});

describe('scoreQuery', () => {
  it('computes precision over the results actually returned, not a flat 5', () => {
    const score = scoreQuery(query(), [product('Milch 1l'), product('Vollmilch')]);
    // 2 relevant of 2 returned — not 2/5, which would punish a small catalogue.
    expect(score.precisionAt5).toBe(1);
  });

  it('computes reciprocal rank from the first relevant hit', () => {
    const score = scoreQuery(query(), [
      product('Rüebli'),
      product('Zwiebeln'),
      product('Vollmilch'),
    ]);
    expect(score.reciprocalRank).toBeCloseTo(1 / 3);
  });

  it('reports zero reciprocal rank when nothing relevant is found', () => {
    const score = scoreQuery(query(), [product('Rüebli'), product('Zwiebeln')]);
    expect(score.reciprocalRank).toBe(0);
  });

  it('records forbidden products that reach the top 5', () => {
    const score = scoreQuery(query(), [product('Milchschokolade', 'coop'), product('Milch 1l')]);
    expect(score.violations).toEqual([{ rank: 1, chain: 'coop', name: 'Milchschokolade' }]);
  });

  it('ignores forbidden products ranked below the top 5', () => {
    const results = [
      product('Milch 1l'),
      product('Vollmilch'),
      product('Bio Milch'),
      product('Milchdrink'),
      product('Milch Halbfett'),
      product('Milchschokolade'),
    ];
    expect(scoreQuery(query(), results).violations).toEqual([]);
  });

  it('flags an empty result set rather than scoring it zero', () => {
    const score = scoreQuery(query(), []);
    expect(score.empty).toBe(true);
    expect(score.returned).toBe(0);
  });
});

describe('buildReport', () => {
  it('excludes empty queries from the means', () => {
    const perfect = scoreQuery(query({ id: 'a' }), [product('Milch')]);
    const empty = scoreQuery(query({ id: 'b' }), []);

    const report = buildReport([perfect, empty]);
    // Averaging the empty query in as a 0 would report 0.5 and blame the
    // ranker for a vendor outage.
    expect(report.precisionAt5).toBe(1);
    expect(report.scored).toBe(1);
    expect(report.emptyQueries).toEqual(['b']);
  });

  it('counts an empty query as a failure in the end-to-end metrics', () => {
    const perfect = scoreQuery(query({ id: 'a' }), [product('Milch')]);
    const empty = scoreQuery(query({ id: 'b' }), []);

    const report = buildReport([perfect, empty]);
    // The ranking metric excuses it; the end-to-end metric must not, or a
    // system answering half its queries reports as near-perfect.
    expect(report.precisionAt5).toBe(1);
    expect(report.overallPrecisionAt5).toBe(0.5);
    expect(report.overallMrr).toBe(0.5);
    expect(report.coverage).toBe(0.5);
  });

  it('separates gate violations from measure violations', () => {
    const gate = scoreQuery(query({ id: 'gate-q', severity: 'gate' }), [product('Milchschokolade')]);
    const measured = scoreQuery(query({ id: 'measure-q' }), [product('Milchschokolade')]);

    const report = buildReport([gate, measured]);
    expect(report.gateViolations.map((v) => v.id)).toEqual(['gate-q']);
    expect(report.measureViolations.map((v) => v.id)).toEqual(['measure-q']);
  });

  it('reports per-bucket means so an easy bucket cannot mask a hard one', () => {
    const good = scoreQuery(query({ id: 'a', bucket: 'brand' }), [product('Milch')]);
    const bad = scoreQuery(query({ id: 'b', bucket: 'compound' }), [product('Rüebli')]);

    const report = buildReport([good, bad]);
    expect(report.byBucket.brand.precisionAt5).toBe(1);
    expect(report.byBucket.compound.precisionAt5).toBe(0);
    expect(report.precisionAt5).toBe(0.5);
  });
});

describe('compareToBaseline', () => {
  const report = buildReport([scoreQuery(query(), [product('Milch'), product('Rüebli')])]);

  it('passes when metrics hold', () => {
    expect(
      compareToBaseline(report, { precisionAt5: 0.5, mrr: 1, coverage: 1, tolerance: 0 }).ok
    ).toBe(true);
  });

  it('fails when a metric drops beyond tolerance', () => {
    const verdict = compareToBaseline(report, {
      precisionAt5: 0.9,
      mrr: 1,
      coverage: 1,
      tolerance: 0.05,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toContain('P@5 regressed');
  });

  it('fails when coverage drops, even if ranking metrics improve', () => {
    // The failure mode this guards: dropping hard queries raises the ranking
    // average, so ranking metrics alone would reward losing them.
    const halfAnswered = buildReport([
      scoreQuery(query({ id: 'a' }), [product('Milch')]),
      scoreQuery(query({ id: 'b' }), []),
    ]);

    const verdict = compareToBaseline(halfAnswered, {
      precisionAt5: 1,
      mrr: 1,
      coverage: 1,
      tolerance: 0.01,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(' ')).toContain('Coverage regressed');
  });

  it('absorbs noise within tolerance', () => {
    expect(
      compareToBaseline(report, { precisionAt5: 0.54, mrr: 1, coverage: 1, tolerance: 0.05 }).ok
    ).toBe(true);
  });
});
