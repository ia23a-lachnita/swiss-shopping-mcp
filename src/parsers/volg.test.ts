import { describe, expect, it } from 'vitest';

import { parseVolgSearchResponse, parseVolgStoresResponse, VolgProduct } from './volg.js';

describe('Volg parser', () => {
  it('parses search response', () => {
    const data: VolgProduct[] = [
      {
        id: 'volg-1',
        name: 'Volg Bio Milch',
        brand: 'Volg',
        price: { amount: 1.80, currency: 'CHF' },
        category: 'Milchprodukte',
      },
    ];

    const result = parseVolgSearchResponse(data, 'https://www.volgshop.ch/de/search?q=milch');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'volg-1',
      name: 'Volg Bio Milch',
      brand: 'Volg',
      price: { current: 1.80, currency: 'CHF' },
    });
  });

  it('marks on-sale products with promotion tag', () => {
    const data: VolgProduct[] = [
      { id: '1', name: 'Sale item', price: { amount: 2.0, currency: 'CHF' }, on_sale: true },
    ];

    const result = parseVolgSearchResponse(data, 'https://example.com');

    expect(result[0].tags).toEqual(['promotion']);
  });

  it('filters products without prices', () => {
    const data: VolgProduct[] = [
      { id: '1', name: 'With price', price: { amount: 3.0, currency: 'CHF' } },
      { id: '2', name: 'No price' },
    ];

    const result = parseVolgSearchResponse(data, 'https://example.com');

    expect(result).toHaveLength(1);
  });

  it('parses stores response', () => {
    const data = [
      {
        id: 'volg-store-1',
        name: 'Volg Zürich',
        city: 'Zürich',
        zip: '8001',
        street: 'Langstrasse',
        street_number: '10',
        latitude: 47.38,
        longitude: 8.53,
        opening_hours: 'Mo-Fr 07:00-19:00',
      },
    ];

    const result = parseVolgStoresResponse(data, 'https://example.com');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'volg-store-1',
      name: 'Volg Zürich',
      latitude: 47.38,
      longitude: 8.53,
      openingHours: 'Mo-Fr 07:00-19:00',
    });
  });
});
