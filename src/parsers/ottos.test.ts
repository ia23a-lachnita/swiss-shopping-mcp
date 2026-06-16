import { describe, expect, it } from 'vitest';

import { OttosProduct, parseOttosSearchResponse, parseOttosStoresResponse } from './ottos.js';

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
});
