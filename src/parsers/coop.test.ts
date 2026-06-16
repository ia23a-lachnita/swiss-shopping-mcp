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
          id: 'coop-123',
          name: 'Coop Naturaplan Milch',
          brand: 'Naturaplan',
          price: { amount: 2.10, currency: 'CHF' },
          category: 'Milchprodukte',
          image_url: 'https://www.coop.ch/image.jpg',
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
        { id: '1', name: 'With price', price: { amount: 3.0, currency: 'CHF' } },
        { id: '2', name: 'Without price' },
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
          id: '1',
          name: 'Bread',
          price: { amount: 3.5, currency: 'CHF' },
          nutrition_facts: {
            energy_kcal: 250,
            protein: 8,
            carbohydrates: 45,
            fat: 4,
          },
        },
      ],
    };

    const result = parseCoopSearchResponse(data, 'https://example.com');

    expect(result[0].nutrition).toEqual({
      energyKcal: 250,
      protein: 8,
      carbs: 45,
      fat: 4,
      fiber: undefined,
      sugar: undefined,
    });
  });

  it('parses stores response', () => {
    const data = {
      stores: [
        {
          id: 'coop-store-1',
          name: 'Coop City Zürich',
          city: 'Zürich',
          zip: '8001',
          street: 'Marktplatz',
          street_number: '5',
          latitude: 47.37,
          longitude: 8.54,
          opening_hours: 'Mo-Sa 08:00-20:00',
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
