import { describe, expect, it } from 'vitest';

import {
  CoopSearchResponse,
  parseCoopSearchResponse,
  parseCoopStoresResponse,
} from './coop.js';

describe('Coop parser', () => {
  it('parses search response with product data', () => {
    const data: CoopSearchResponse = {
      products: [
        {
          code: 'coop-123',
          name: 'Coop Naturaplan Milch',
          brandName: 'Naturaplan',
          price: { value: 2.10, currencyIso: 'CHF' },
          primaryCategory: { name: 'Milchprodukte' },
          images: [{ url: 'https://www.coop.ch/image.jpg' }],
        },
      ],
      total: 1,
    };

    const result = parseCoopSearchResponse(data, 'https://www.coop.ch/de/search?q=milch');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'coop-123',
      name: 'Coop Naturaplan Milch',
      brand: 'Naturaplan',
      price: { current: 2.10, currency: 'CHF' },
      category: 'Milchprodukte',
    });
  });

  it('filters products without prices', () => {
    const data: CoopSearchResponse = {
      products: [
        { code: '1', name: 'With price', price: { value: 3.0, currencyIso: 'CHF' } },
        { code: '2', name: 'Without price' },
      ],
    };

    const result = parseCoopSearchResponse(data, 'https://example.com');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('With price');
  });

  it('parses nutrition data', () => {
    const data: CoopSearchResponse = {
      products: [
        {
          code: '1',
          name: 'Bread',
          price: { value: 3.5, currencyIso: 'CHF' },
        },
      ],
    };

    const result = parseCoopSearchResponse(data, 'https://example.com');

    expect(result[0].nutrition).toBeUndefined();
  });

  it('parses stores response', () => {
    const data = {
      locations: [
        {
          vstId: 'coop-store-1',
          name: 'Coop City Zürich',
          address: {
            town: 'Zürich',
            postalCode: '8001',
            line1: 'Marktplatz 5',
          },
          geoPoint: {
            latitude: 47.37,
            longitude: 8.54,
          },
          currentOpeningHours: 'Mo-Sa 08:00-20:00',
        },
      ],
    };

    const result = parseCoopStoresResponse(data, 'https://example.com');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'coop-store-1',
      name: 'Coop City Zürich',
      latitude: 47.37,
      longitude: 8.54,
      openingHours: 'Mo-Sa 08:00-20:00',
    });
  });
});
