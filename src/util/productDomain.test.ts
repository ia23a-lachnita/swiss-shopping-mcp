import { describe, it, expect } from 'vitest';
import { crossesFoodBoundary, nonFoodStem, queryIsKnownFood, queryWantsNonFood } from './productDomain.js';
import { HYPERNYMS } from './matcher.js';

describe('productDomain', () => {
  it('marks the products that were actually reaching the top 5', () => {
    // Every case here was measured in src/eval/fixtures-pool with
    // keptAtCapture: true — i.e. it survived the filter before this existed.
    const offenders: Array<[string, { name: string; brand?: string }]> = [
      ['Obst', { name: 'Dr. Beckmann Fleckenentferner Fleckenteufel Obst & Getränke', brand: 'Dr.Beckmann' }],
      ['Obst', { name: 'Dettol No-Touch Automatischer Seifenspender Nachfüller Gartenfrüchte' }],
      ['lait entier', { name: 'Palmolive Flüssigseife Milch+Honig' }],
      ['lait entier', { name: 'Ultra Doux Shampoo sanfte Hafermilch' }],
      ['beurre', { name: 'Garnier Ultra Doux Shampoo Avocado-Öl & Sheabutter' }],
    ];
    for (const [query, product] of offenders) {
      expect(crossesFoodBoundary(query, product), `${query} / ${product.name}`).toBe(true);
    }
  });

  it('leaves a non-food query alone, which is the whole reason the rule is symmetric', () => {
    // "Zahnpasta", "Waschmittel" and "Reinigungsmittel" are golden queries whose
    // pools hold 113, 109 and 53 correct non-food products. A rule keyed on the
    // product alone would wipe out all three.
    expect(queryWantsNonFood('Reinigungsmittel')).toBe(true);
    expect(crossesFoodBoundary('Reinigungsmittel', { name: 'Allzweckreiniger' })).toBe(false);
    expect(crossesFoodBoundary('Waschmittel', { name: 'Flüssig Waschmittel' })).toBe(false);
    expect(crossesFoodBoundary('Zahnpasta', { name: 'Kinder Zahnpasta' })).toBe(false);
  });

  it('does not touch food that merely sounds cleansing', () => {
    for (const name of ['Milchdrink UHT', 'Reis Basmati', 'Mischobst', 'Butter', 'Rahm']) {
      expect(crossesFoodBoundary('Obst', { name }), name).toBe(false);
    }
  });

  it('reads the brand too, since Migros and Aldi put the maker there', () => {
    expect(crossesFoodBoundary('Obst', { name: 'Zitrone', brand: 'Frosch Reiniger' })).toBe(true);
  });

  it('declines to fire on a query whose domain it cannot establish', () => {
    // "Optimus" is a Swiss cleaning brand. A first version read the absence of
    // a cleaning stem in the query as evidence of food and disqualified every
    // Optimus cleaner from its own brand search — caught by
    // mcp.search.deep.test.ts, not by design.
    expect(queryIsKnownFood('optimus')).toBe(false);
    expect(crossesFoodBoundary('optimus', { name: 'Optimus WC-Reiniger' })).toBe(false);
  });

  it('knows the food vocabulary in both languages', () => {
    expect(queryIsKnownFood('Obst')).toBe(true);
    expect(queryIsKnownFood('beurre')).toBe(true); // -> butter
    expect(queryIsKnownFood('lait entier')).toBe(true); // -> milch
  });

  it('covers every food hypernym the matcher knows', () => {
    // Guards the duplication: productDomain cannot import HYPERNYMS without
    // closing an import cycle, so the test does it instead.
    const cleaning = new Set(['reinigungsmittel', 'putzmittel', 'waschmittel']);
    for (const key of Object.keys(HYPERNYMS)) {
      if (cleaning.has(key)) continue;
      expect(queryIsKnownFood(key), `${key} missing from FOOD_QUERY_TERMS`).toBe(true);
    }
  });

  it('folds case and umlauts before matching', () => {
    expect(nonFoodStem('WEICHSPÜLER')).toBe('weichspuler');
    expect(nonFoodStem('Flüssigseife')).toBe('seife');
  });

  it('reports no stem for ordinary groceries', () => {
    expect(nonFoodStem('Gala Äpfel')).toBeUndefined();
    expect(nonFoodStem('')).toBeUndefined();
  });
});
