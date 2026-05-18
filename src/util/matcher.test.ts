import { describe, expect, it } from 'vitest';

import { calculateMatchStrength, normalize } from './matcher.js';
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
});
