import { describe, expect, it } from 'vitest';

import { buildTaxonomy } from './taxonomyBuilder.js';
import { NormalizedProduct } from '../adapters/types.js';

function product(overrides: Partial<NormalizedProduct>): NormalizedProduct {
  return {
    id: 'p1',
    chain: 'migros',
    name: 'Test Product',
    price: { current: 1.0 },
    ...overrides,
  };
}

describe('buildTaxonomy', () => {
  it('returns empty object for empty products', () => {
    expect(buildTaxonomy([])).toEqual({});
  });

  it('discovers co-occurring tokens from product names', () => {
    const products = [
      product({ name: 'Zitrone Bio' }),
      product({ name: 'Zitrone Gelb' }),
      product({ name: 'Limette Frisch' }),
      product({ name: 'Zitrone Bio' }),
      product({ name: 'Zitrone Gelb' }),
    ];

    const taxonomy = buildTaxonomy(products);

    // "zitrone" appears in 4 products, "bio" in 2, "gelb" in 2
    expect(taxonomy['zitrone']).toBeDefined();
    expect(taxonomy['zitrone']).toContain('gelb');
    expect(taxonomy['zitrone']).toContain('bio');
  });

  it('discovers co-occurring tokens from categories', () => {
    const products = [
      product({ name: 'Apfel', category: 'Obst' }),
      product({ name: 'Birne', category: 'Obst' }),
      product({ name: 'Banane', category: 'Obst' }),
      product({ name: 'Apfel Rot', category: 'Obst' }),
    ];

    const taxonomy = buildTaxonomy(products);

    // All in same category "obst" — "apfel" appears in 2 products
    expect(taxonomy['obst']).toBeDefined();
    expect(taxonomy['obst']).toContain('apfel');
  });

  it('limits aliases to MAX_ALIASES (8)', () => {
    const products = Array.from({ length: 20 }, (_, i) =>
      product({ name: `Token${i} Shared` })
    );

    const taxonomy = buildTaxonomy(products);

    for (const token of Object.keys(taxonomy)) {
      expect(taxonomy[token].length).toBeLessThanOrEqual(8);
    }
  });

  it('filters tokens shorter than 2 characters', () => {
    const products = [
      product({ name: 'A B C' }),
      product({ name: 'A B D' }),
    ];

    const taxonomy = buildTaxonomy(products);

    expect(taxonomy['a']).toBeUndefined();
    expect(taxonomy['b']).toBeUndefined();
    expect(taxonomy['c']).toBeUndefined();
  });

  it('requires minimum 2 product co-occurrence', () => {
    const products = [
      product({ name: 'UniqueToken1' }),
      product({ name: 'UniqueToken2' }),
    ];

    const taxonomy = buildTaxonomy(products);

    expect(Object.keys(taxonomy)).toHaveLength(0);
  });
});
