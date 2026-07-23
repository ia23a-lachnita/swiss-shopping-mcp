import { describe, expect, it } from 'vitest';

import { parseVolgSearchResponse, parseVolgStoresResponse, parseVolgWooCommerceResponse, VolgProduct } from './volg.js';

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

  describe('parseVolgWooCommerceResponse (live path)', () => {
    it('extracts a trailing pack size from the product name', () => {
      // Real Volg WooCommerce Store API response shape - weight/
      // formatted_weight are always unpopulated ("" / "n. v."), pack size
      // only appears embedded in the name.
      const data = [
        {
          id: '123',
          name: 'Kondensmilch 300g',
          prices: { price: '195', currency_code: 'CHF', currency_minor_unit: 2 },
          weight: '',
          formatted_weight: 'n. v.',
        },
      ];

      const result = parseVolgWooCommerceResponse(data, 'https://www.volgshop.ch/x');

      expect(result[0]).toMatchObject({
        name: 'Kondensmilch',
        size: '300g',
      });
    });

    it('leaves size undefined when the name has no trailing size token', () => {
      const data = [
        {
          id: '1',
          name: 'Volg Bio Milch',
          prices: { price: '180', currency_code: 'CHF', currency_minor_unit: 2 },
        },
      ];

      const result = parseVolgWooCommerceResponse(data, 'https://www.volgshop.ch/x');

      expect(result[0].name).toBe('Volg Bio Milch');
      expect(result[0].size).toBeUndefined();
    });
  });
});
