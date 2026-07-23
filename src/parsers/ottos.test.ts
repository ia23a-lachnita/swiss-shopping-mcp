import { describe, expect, it } from 'vitest';

import { OttosOccProduct, OttosProduct, parseOttosOccProduct, parseOttosSearchResponse, parseOttosStoresResponse } from './ottos.js';

describe('Ottos parser', () => {
  it('parses search response', () => {
    const data: OttosProduct[] = [
      {
        id: 'ottos-1',
        name: "Otto's Kaffee",
        brand: "Otto's",
        price: { amount: 8.90, currency: 'CHF' },
        category: 'Getränke',
        stockLevel: 15,
      },
    ];

    const result = parseOttosSearchResponse(data, 'https://www.ottos.ch/de/search?q=kaffee');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'ottos-1',
      name: "Otto's Kaffee",
      brand: "Otto's",
      price: { current: 8.90, currency: 'CHF' },
      stockLevel: 15,
    });
  });

  it('filters products without prices', () => {
    const data: OttosProduct[] = [
      { id: '1', name: 'With price', price: { amount: 5.0, currency: 'CHF' } },
      { id: '2', name: 'No price' },
    ];

    const result = parseOttosSearchResponse(data, 'https://example.com');

    expect(result).toHaveLength(1);
  });

  it('parses stores response', () => {
    const data = [
      {
        id: 'ottos-store-1',
        name: "Otto's Luzern",
        city: 'Luzern',
        zip: '6004',
        street: 'Pilatusstrasse',
        street_number: '20',
        latitude: 47.05,
        longitude: 8.31,
        opening_hours: 'Mo-Fr 09:00-18:00',
      },
    ];

    const result = parseOttosStoresResponse(data, 'https://example.com');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'ottos-store-1',
      name: "Otto's Luzern",
      latitude: 47.05,
      longitude: 8.31,
      openingHours: 'Mo-Fr 09:00-18:00',
    });
  });

  describe('parseOttosOccProduct (live path)', () => {
    it('extracts a trailing pack size from the product name', () => {
      // Real Otto's OCC API response shape - the API has no dedicated
      // size/weight field, pack size only appears embedded in the name.
      const product: OttosOccProduct = {
        code: '388455',
        name: 'Mulino Bianco Girotondi 800 g',
        price: { formattedValue: 'CHF 3.95' },
      };

      const result = parseOttosOccProduct(product, 'https://api.ottos.ch/x');

      expect(result).toMatchObject({
        name: 'Mulino Bianco Girotondi',
        size: '800 g',
      });
    });

    it('leaves size undefined when the name has no trailing size token', () => {
      const product: OttosOccProduct = {
        code: '1',
        name: "Otto's Kaffee",
        price: { formattedValue: 'CHF 8.90' },
      };

      const result = parseOttosOccProduct(product, 'https://api.ottos.ch/x');

      expect(result?.name).toBe("Otto's Kaffee");
      expect(result?.size).toBeUndefined();
    });
  });
});
