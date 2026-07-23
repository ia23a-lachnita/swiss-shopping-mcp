import { describe, expect, it } from 'vitest';
import { extractTrailingSize } from './productSize.js';

describe('extractTrailingSize', () => {
  // Real product names verified live against Volg (WooCommerce) and Otto's (OCC) APIs.
  it.each([
    ['Kondensmilch 300g', 'Kondensmilch', '300g'],
    ['Kinder Milchschnitte 5x28g', 'Kinder Milchschnitte', '5x28g'],
    ['Nivea Sun Sonnenmilch LSF 30 200ml', 'Nivea Sun Sonnenmilch LSF 30', '200ml'],
    ['Emmi Good Day Milch laktosefrei UHT 1l', 'Emmi Good Day Milch laktosefrei UHT', '1l'],
    ['Milchdrink UHT 5dl', 'Milchdrink UHT', '5dl'],
    ['Mulino Bianco Girotondi 800 g', 'Mulino Bianco Girotondi', '800 g'],
    ['Swiss Alp Health ExtraCell Beauty Collagen Schokolade 20 x 15 g', 'Swiss Alp Health ExtraCell Beauty Collagen Schokolade', '20 x 15 g'],
  ])('extracts size from %s', (input, expectedName, expectedSize) => {
    expect(extractTrailingSize(input)).toEqual({ name: expectedName, size: expectedSize });
  });

  it('leaves the name untouched when there is no trailing size token', () => {
    expect(extractTrailingSize('Laktosefreie Milch UHT 1.5 % Fett')).toEqual({
      name: 'Laktosefreie Milch UHT 1.5 % Fett',
    });
  });

  it('does not treat a mid-name number without a unit as a size', () => {
    // "LSF 30" (SPF 30) mid-string must not be mistaken for a size - only
    // the actual trailing "200ml" should match.
    expect(extractTrailingSize('Sonnenmilch LSF 30')).toEqual({
      name: 'Sonnenmilch LSF 30',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(extractTrailingSize('  Kondensmilch 300g  ')).toEqual({
      name: 'Kondensmilch',
      size: '300g',
    });
  });
});
