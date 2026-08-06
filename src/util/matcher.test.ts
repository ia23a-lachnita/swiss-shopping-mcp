import { describe, expect, it } from 'vitest';

import { SYNONYM_GROUPS, calculateMatchStrength, normalize, sortProducts } from './matcher.js';
import { NormalizedProduct } from '../adapters/types.js';

function product(overrides: Partial<NormalizedProduct>): NormalizedProduct {
  return {
    id: 'p1',
    chain: 'migros',
    name: 'Penne Rigate',
    price: { current: 1.2 },
    ...overrides,
  };
}

describe('product matcher', () => {
  it('normalizes diacritics and punctuation', () => {
    expect(normalize("Crème fraîche - Bio!")).toBe('creme fraiche bio');
  });

  it('matches narrow taxonomy aliases in balanced mode', () => {
    expect(calculateMatchStrength(product({ name: 'Spaghetti' }), 'pasta', 'balanced')).toBeGreaterThan(0);
  });

  it('does not apply taxonomy aliases in literal mode', () => {
    expect(calculateMatchStrength(product({ name: 'Spaghetti' }), 'pasta', 'literal')).toBe(0);
  });

  it('requires every query token to match directly or through taxonomy', () => {
    const result = calculateMatchStrength(
      product({ name: 'Penne Rigate', tags: ['vegan', 'vegetarian'] }),
      'pasta vegan',
      'balanced',
    );

    expect(result).toBeGreaterThan(0);
  });

  it('uses dynamic taxonomy when provided', () => {
    const dynamicTaxonomy: Record<string, string[]> = {
      zitrone: ['citrus', 'obst'],
    };

    const p = product({ name: 'Citrus Frucht' });
    const withDynamic = calculateMatchStrength(p, 'zitrone', 'balanced', dynamicTaxonomy);

    // Dynamic taxonomy should find "citrus" as an alias for "zitrone"
    expect(withDynamic).toBeGreaterThan(0);
  });

  it('dynamic taxonomy overrides static taxonomy for same token', () => {
    const dynamicTaxonomy: Record<string, string[]> = {
      pasta: ['nudeln', 'teigwaren'],
    };

    const p = product({ name: 'Nudeln' });
    const withDynamic = calculateMatchStrength(p, 'pasta', 'balanced', dynamicTaxonomy);

    // Dynamic taxonomy maps "pasta" → ["nudeln", "teigwaren"]
    expect(withDynamic).toBeGreaterThan(0);
  });

  it('matches an inflected modifier against the stem the retailer wrote', () => {
    // "Käse gerieben" is how Coop spells it; "geriebener Käse" is how a
    // shopper asks for it. This returned 0 — the product was discarded, not
    // ranked lower — and left the query with no results from any chain.
    const grated = product({ name: 'Käse gerieben' });
    expect(calculateMatchStrength(grated, 'geriebener Käse', 'balanced')).toBeGreaterThan(0);
  });

  it('still requires the noun, wherever the retailer put it', () => {
    // "Le Gruyère gerieben" is grated cheese and a human would say so. It used
    // to qualify only through its category, because the taxonomy did know
    // Gruyère was a cheese but was keyed by the English word `cheese` and
    // looked up by the shopper's German one — the entry existed and was
    // unreachable. Keyed by `kase`, the uncategorised product now qualifies
    // too, one rank below the categorised one.
    const named = product({ name: 'Le Gruyère gerieben', category: 'Käse' });
    const uncategorised = product({ name: 'Le Gruyère gerieben' });

    expect(calculateMatchStrength(named, 'geriebener Käse', 'balanced')).toBeGreaterThan(
      calculateMatchStrength(uncategorised, 'geriebener Käse', 'balanced')
    );
    expect(calculateMatchStrength(uncategorised, 'geriebener Käse', 'balanced')).toBeGreaterThan(0);

    // What the noun requirement is actually protecting: being grated is not
    // enough to answer a query for cheese.
    expect(calculateMatchStrength(product({ name: 'Karotten gerieben' }), 'geriebener Käse', 'balanced')).toBe(0);
  });

  it('keeps a product that misses the modifier but ranks it below one that has it', () => {
    const grated = product({ name: 'Cheddar gerieben', category: 'Käse' });
    const sliced = product({ name: 'Cheddar Scheiben', category: 'Käse' });
    const crisps = product({ name: 'Maisbällchen mit Käsegeschmack' });

    const score = (p: NormalizedProduct): number =>
      calculateMatchStrength(p, 'geriebener Käse', 'balanced');

    expect(score(grated)).toBeGreaterThan(score(sliced));
    // The crisp carries "Käse" in its *name*, so a plain conjunctive score
    // would rank it above grated cheese that only carries it in a category.
    expect(score(grated)).toBeGreaterThan(score(crisps));
  });

  it('excludes a product that fails a diet claim rather than ranking it lower', () => {
    // Ordinary milk and coconut milk reached ranks 3-5 of "laktosefreie Milch"
    // when every modifier was treated as a preference, taking that query's P@5
    // from 1.0 to 0.4. The inflection still has to be tolerated — "laktosefreie"
    // against "Laktosefreie Milch UHT" is what the shopper actually types.
    const free = product({ name: 'Laktosefreie Milch UHT 1.5% Fett' });
    const ordinary = product({ name: 'Milch' });
    const coconut = product({ name: 'Kokosnussmilch' });

    expect(calculateMatchStrength(free, 'laktosefreie Milch', 'balanced')).toBeGreaterThan(0);
    expect(calculateMatchStrength(ordinary, 'laktosefreie Milch', 'balanced')).toBe(0);
    expect(calculateMatchStrength(coconut, 'laktosefreie Milch', 'balanced')).toBe(0);
  });

  it('does not let the co-occurrence taxonomy satisfy a diet claim', () => {
    // One "Glutenfreies Brot" in the result set is enough for the dynamic
    // taxonomy to learn that `glutenfreies` goes with `brot`, and then every
    // bread qualifies. Found in the browser, not here: the eval fixtures are
    // captured without the local catalog that surfaced the offending products.
    const spelt = product({ name: 'Dinkel-Vollkornbrot', category: 'Brot & Backwaren' });
    const learned = { glutenfreies: ['brot'] };

    expect(calculateMatchStrength(spelt, 'glutenfreies Brot', 'balanced', learned)).toBe(0);
    // A preference may still be satisfied that way — it only costs rank.
    const grated = product({ name: 'Reibkäse', category: 'Käse' });
    expect(
      calculateMatchStrength(grated, 'geriebener Käse', 'balanced', { geriebener: ['reibkase'] })
    ).toBeGreaterThan(0);
  });

  it('never lets a missing noun be forgiven the way a missing modifier is', () => {
    // The reported defect: "Protein Milch" returned bread, because both words
    // occur in bread's ingredient text. Neither token is a modifier, so both
    // stay mandatory.
    const bread = product({ name: 'Protein Brot', tags: ['weizen', 'protein'] });
    expect(calculateMatchStrength(bread, 'Protein Milch', 'balanced')).toBe(0);
  });

  it('does not read a noun that merely starts with a modifier as one', () => {
    const white = product({ name: 'Weisswein Chasselas' });
    expect(calculateMatchStrength(white, 'Rotwein', 'balanced')).toBe(0);
  });

  it('answers a French query with the German product it means', () => {
    const milk = product({ name: 'Vollmilch', brand: 'Valflora' });
    const unrelated = product({ name: 'Cervelat Paar' });

    expect(calculateMatchStrength(milk, 'lait entier', 'balanced')).toBeGreaterThan(0);
    expect(calculateMatchStrength(unrelated, 'lait entier', 'balanced')).toBe(0);
  });

  it('does not rank the shopper\'s own French word above the product it asked for', () => {
    // "Biotherm Lait Corporel Körpermilch" spells the French word out, so
    // scoring only the shopper's words put a body lotion above Vollmilch for
    // "lait entier". Scoring the dispatched German reading too levels them,
    // and price decides — a translated query must not reward the spelling.
    const milk = product({ name: 'Vollmilch', brand: 'Valflora' });
    const lotion = product({ name: 'Biotherm Lait Corporel Körpermilch' });

    expect(calculateMatchStrength(milk, 'lait entier', 'balanced')).toBeGreaterThanOrEqual(
      calculateMatchStrength(lotion, 'lait entier', 'balanced')
    );
  });

  it('answers a Swiss-German query with the standard-German word for the same thing', () => {
    // "Rüebli" appeared only as a VALUE under `gemuse`, never as a key, so it
    // expanded to nothing — and since an unrecognised token is mandatory, that
    // disqualified every carrot. Measured over the frozen pool: the query kept
    // Rüebli biscuits and a Rüebli cake and dropped Migros Karotten, Snack
    // Karotten and Baby Karotten. Recall 0.150.
    const carrots = product({ name: 'Karotten', brand: 'M-Budget' });
    expect(calculateMatchStrength(carrots, 'Rüebli', 'balanced')).toBeGreaterThan(0);
  });

  it('expands a synonym in both directions', () => {
    // Synonymy is symmetric by definition, unlike the hypernym table. Deriving
    // both directions from one group is what stops a pair being added one way
    // round, which is how rueebli/karotte came to be missing.
    const carrots = product({ name: 'Karotten' });
    const ruebli = product({ name: 'Rüebli' });
    expect(calculateMatchStrength(carrots, 'Rüebli', 'balanced')).toBeGreaterThan(0);
    expect(calculateMatchStrength(ruebli, 'Karotten', 'balanced')).toBeGreaterThan(0);
  });

  it('still refuses to expand a hypernym member to its siblings', () => {
    // The reason the taxonomy is directional, and the thing symmetric synonym
    // expansion must not quietly undo: an apple and a banana are two different
    // fruits, where Rüebli and Karotte are one vegetable.
    const banana = product({ name: 'Bananen', category: 'Obst' });
    expect(calculateMatchStrength(banana, 'Apfel', 'balanced')).toBe(0);
  });

  it('scores a synonym below the shopper\'s own spelling', () => {
    // Equal at the retrieval layer per Lucene's SynonymQuery — a carrot answers
    // "Rüebli" as well as a Rüebli does — but the literal spelling still takes
    // the tie through the whole-name bonus.
    const ruebli = product({ name: 'Rüebli' });
    const carrots = product({ name: 'Karotten' });
    expect(calculateMatchStrength(ruebli, 'Rüebli', 'balanced')).toBeGreaterThan(
      calculateMatchStrength(carrots, 'Rüebli', 'balanced')
    );
  });

  it('keeps every synonym in normalise() form', () => {
    // An entry carrying an umlaut is looked up against normalised text and
    // therefore never matches anything. That is how the modifier table lost
    // `uht` for a month — silently, with no test able to notice.
    for (const group of SYNONYM_GROUPS) {
      for (const term of group) expect(normalize(term)).toBe(term);
    }
  });

  it('counts dried fruit as fruit', () => {
    // Sultaninen are dried grapes. The filter dropped them for "Obst", and the
    // golden labels did not name them either, so nothing could see it.
    const raisins = product({ name: 'Sultaninen', brand: 'Migros' });
    expect(calculateMatchStrength(raisins, 'Obst', 'balanced')).toBeGreaterThan(0);
  });

  it('applies neither modifier tolerance nor translation in literal mode', () => {
    const grated = product({ name: 'Cheddar gerieben', category: 'Käse' });
    const milk = product({ name: 'Vollmilch' });

    expect(calculateMatchStrength(grated, 'geriebener Käse', 'literal')).toBe(0);
    expect(calculateMatchStrength(milk, 'lait entier', 'literal')).toBe(0);
  });

  it('ranks a compound by its head, not by what it contains', () => {
    // "Mischobst" is fruit; "Obstessig" is a vinegar and "Obstriegel" a snack
    // bar. Plain containment scored all three the same, and the browser showed
    // it: the top four results for "Obst" were baby purée, vinegar, mixed fruit
    // and a stain remover.
    const mixed = calculateMatchStrength(product({ name: 'Mischobst' }), 'Obst', 'balanced');
    const vinegar = calculateMatchStrength(product({ name: 'Naturaplan Bio Demeter Obstessig' }), 'Obst', 'balanced');
    const realFruit = calculateMatchStrength(product({ name: 'Granatapfel' }), 'Obst', 'balanced');

    expect(mixed).toBeGreaterThan(realFruit);
    expect(realFruit).toBeGreaterThan(vinegar);
    // Demoted, not discarded: a fruit bar is a defensible thing to offer, just
    // not ahead of fruit.
    expect(vinegar).toBeGreaterThan(0);
  });

  it('does not mistake an inflection for a compound modifier', () => {
    // The head rule has to survive a plural, or it would demote half a
    // catalogue: "Karotten" is exactly what "Karotte" asked for.
    const plural = calculateMatchStrength(product({ name: 'Karotten' }), 'Karotte', 'balanced');
    const modifierPosition = calculateMatchStrength(
      product({ name: 'Karottenkuchen' }),
      'Karotte',
      'balanced'
    );

    expect(plural).toBeGreaterThanOrEqual(90);
    expect(plural).toBeGreaterThan(modifierPosition);
  });

  it('answers a category query with the products in that category', () => {
    // The table used to be keyed by English concept names, so `TAXONOMY['obst']`
    // and `TAXONOMY['teigwaren']` were both undefined — and since an
    // unrecognised token is mandatory, every product that did not spell the
    // category word out was discarded. Measured against the captured vendor
    // pools, "Teigwaren" kept 10 of 87 relevant products and
    // "Reinigungsmittel" kept none of 32.
    expect(calculateMatchStrength(product({ name: 'Hörnli' }), 'Teigwaren', 'balanced')).toBeGreaterThan(0);
    expect(calculateMatchStrength(product({ name: 'Granatapfel' }), 'Obst', 'balanced')).toBeGreaterThan(0);
    expect(
      calculateMatchStrength(product({ name: 'Allzweckreiniger Zitrone' }), 'Reinigungsmittel', 'balanced')
    ).toBeGreaterThan(0);
  });

  it('does not expand a category member to its siblings', () => {
    // Directional on purpose: expanding both ways would answer "Apfel" with a
    // banana, trading the recall defect for a precision one.
    expect(calculateMatchStrength(product({ name: 'Banane' }), 'Apfel', 'balanced')).toBe(0);
    expect(calculateMatchStrength(product({ name: 'Spaghetti' }), 'Hörnli', 'balanced')).toBe(0);
  });

  it('matches a closed compound the retailer writes open', () => {
    // Shoppers close up noun phrases and catalogues do not: "Freilandeier" is
    // shelved as "Eier, Freiland" and "Basmatireis" as "Basmati Reis".
    const eggs = product({ name: 'Eier, Freiland 6 Stück' });
    const rice = product({ name: 'Basmati Reis' });

    expect(calculateMatchStrength(eggs, 'Freilandeier', 'balanced')).toBeGreaterThan(0);
    expect(calculateMatchStrength(rice, 'Basmatireis', 'balanced')).toBeGreaterThan(0);
    // Below an exact spelling, so a product named as asked still outranks it.
    expect(calculateMatchStrength(rice, 'Basmatireis', 'balanced')).toBeLessThan(
      calculateMatchStrength(product({ name: 'Basmatireis' }), 'Basmatireis', 'balanced')
    );
  });

  it('requires both halves of a split compound on the same product', () => {
    // The guard that keeps compound splitting from becoming "any token matches
    // something": a product carrying only one half is not an answer.
    expect(calculateMatchStrength(product({ name: 'Eier, Boden 10 Stück' }), 'Freilandeier', 'balanced')).toBe(0);
    expect(calculateMatchStrength(product({ name: 'Risotto Reis' }), 'Basmatireis', 'balanced')).toBe(0);
  });

  it('sortProducts uses dynamic taxonomy for ranking', () => {
    const dynamicTaxonomy: Record<string, string[]> = {
      zitrone: ['citrus'],
    };

    const exact = product({ name: 'Zitrone' });
    const alias = product({ name: 'Citrus Frucht' });
    const unrelated = product({ name: 'Brot' });

    const sorted = [exact, alias, unrelated].sort((a, b) =>
      sortProducts(a, b, 'zitrone', 'balanced', dynamicTaxonomy)
    );

    // Zitrone should be first (direct match), then citrus (via dynamic taxonomy)
    expect(sorted[0].name).toBe('Zitrone');
    expect(sorted[1].name).toBe('Citrus Frucht');
  });
});
