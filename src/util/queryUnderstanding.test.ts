import { describe, expect, it } from 'vitest';

import { normalize } from './normalize.js';
import {
  MODIFIERS,
  CROSS_LANGUAGE_TERMS,
  modifierOf,
  vendorQueryFor,
} from './queryUnderstanding.js';

describe('modifier vocabulary', () => {
  it('is written in normalised form', () => {
    // A stem with an umlaut in it would never match anything, silently: the
    // fields it is compared against have already been folded.
    const unnormalised = MODIFIERS.flatMap((entry) => entry.forms).filter(
      (form) => normalize(form) !== form
    );
    expect(unnormalised).toEqual([]);
  });

  it('claims each surface form exactly once', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const entry of MODIFIERS) {
      for (const form of entry.forms) {
        const owner = seen.get(form);
        if (owner !== undefined && owner !== entry.forms[0]) {
          collisions.push(`${form}: ${owner}/${entry.forms[0]}`);
        }
        seen.set(form, entry.forms[0]);
      }
    }
    expect(collisions).toEqual([]);
  });

  it('treats diet and allergen claims as constraints, not preferences', () => {
    // The line that keeps ordinary milk out of "laktosefreie Milch".
    for (const token of ['glutenfrei', 'laktosefrei', 'vegan', 'bio', 'zuckerfrei']) {
      expect(modifierOf(token)?.kind, token).toBe('constraint');
    }
    for (const token of ['gerieben', 'dunkel', 'rotes', 'entier', 'frisch']) {
      expect(modifierOf(token)?.kind, token).toBe('preference');
    }
  });

  it('maps romance terms to normalised German', () => {
    const unnormalised = Object.entries(CROSS_LANGUAGE_TERMS).flatMap(([term, equivalents]) =>
      [term, ...equivalents].filter((value) => normalize(value) !== value)
    );
    expect(unnormalised).toEqual([]);
  });
});

describe('modifierOf', () => {
  it.each([
    ['geriebener', 'gerieben'],
    ['geriebene', 'gerieben'],
    ['glutenfreies', 'glutenfrei'],
    ['gehackte', 'gehackt'],
    ['rotes', 'rot'],
    ['griechischer', 'griechisch'],
    ['dunkle', 'dunkel'],
    ['entier', 'entier'],
  ])('reads %s as the modifier %s', (token, stem) => {
    expect(modifierOf(token)?.forms[0]).toBe(stem);
  });

  it.each(['rotwein', 'magerquark', 'brot', 'milch', 'eier', 'biologisch', 'weisswein'])(
    'leaves %s a mandatory noun',
    (token) => {
      // Prefix-stripping would read "Rotwein" as red-something and "Eier" as
      // "Ei", which is why only whole stem + ending forms count.
      expect(modifierOf(token)).toBeUndefined();
    }
  );
});

describe('vendorQueryFor', () => {
  it('canonicalises an inflected modifier without touching the noun', () => {
    // Measured on the live fan-out: the inflected form returns one grated
    // cheese among cheese-flavoured crisps, the canonical form returns eight.
    expect(vendorQueryFor('geriebener Käse')).toBe('gerieben Käse');
    expect(vendorQueryFor('glutenfreies Brot')).toBe('glutenfrei Brot');
    expect(vendorQueryFor('rotes Thai Curry')).toBe('rot Thai Curry');
  });

  it('translates a fully romance query into German', () => {
    // Case is irrelevant to the vendors' own search; only the umlaut in
    // "Käse" has to survive, which is what GERMAN_SPELLING is for.
    expect(vendorQueryFor('lait entier')).toBe('milch');
    expect(vendorQueryFor("jus d'orange")).toBe('saft orange');
    expect(vendorQueryFor('beurre')).toBe('butter');
    expect(vendorQueryFor('fromage')).toBe('Käse');
  });

  it('leaves a query alone when any token is unknown', () => {
    // `caffe` and `latte` are Italian, but `emmi` is a brand — translating
    // here would turn a working brand query into a query for coffee.
    expect(vendorQueryFor('Emmi Caffè Latte')).toBe('Emmi Caffè Latte');
    expect(vendorQueryFor('Zweifel Chips')).toBe('Zweifel Chips');
    expect(vendorQueryFor('Vollmilch')).toBe('Vollmilch');
    expect(vendorQueryFor('Protein Milch')).toBe('Protein Milch');
  });

  it('returns the same answer when asked twice', () => {
    // Memoised, so a stale or shared entry would show up here.
    expect(vendorQueryFor('lait entier')).toBe(vendorQueryFor('lait entier'));
    expect(vendorQueryFor('geriebener Käse')).toBe('gerieben Käse');
  });
});
