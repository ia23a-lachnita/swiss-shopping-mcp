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
