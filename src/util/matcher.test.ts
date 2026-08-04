import { describe, expect, it } from 'vitest';

import { calculateMatchStrength, normalize, sortProducts } from './matcher.js';
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
    // "Le Gruyère gerieben" is grated cheese and a human would say so, but
    // nothing in its name says "Käse". It qualifies through its category and
    // would not qualify without one — recognising Gruyère as a cheese is a
    // taxonomy problem, and pretending otherwise here would mean accepting
    // any product that merely happens to be grated.
    const named = product({ name: 'Le Gruyère gerieben', category: 'Käse' });
    const uncategorised = product({ name: 'Le Gruyère gerieben' });

    expect(calculateMatchStrength(named, 'geriebener Käse', 'balanced')).toBeGreaterThan(0);
    expect(calculateMatchStrength(uncategorised, 'geriebener Käse', 'balanced')).toBe(0);
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

  it('applies neither modifier tolerance nor translation in literal mode', () => {
    const grated = product({ name: 'Cheddar gerieben', category: 'Käse' });
    const milk = product({ name: 'Vollmilch' });

    expect(calculateMatchStrength(grated, 'geriebener Käse', 'literal')).toBe(0);
    expect(calculateMatchStrength(milk, 'lait entier', 'literal')).toBe(0);
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
