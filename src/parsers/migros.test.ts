import { describe, expect, it } from 'vitest';

import {
  MigrosSearchResponse,
  parseMigrosSearchResponse,
  parseMigrosStoresResponse,
} from './migros.js';

describe('Migros parser', () => {
  it('parses search response with product data', () => {
    const data: MigrosSearchResponse = {
      products: [
        {
          id: 12345,
          name: 'Migros Vollmilch',
          brand_name: 'Migros',
          price: { amount: 1.95, currency: 'CHF' },
          category_name: 'Milchprodukte',
          image_url: 'https://www.migros.ch/image.jpg',
        },
      ],
      total: 1,
    };

    const result = parseMigrosSearchResponse(data, 'https://www.migros.ch/de/produkte?q=milch');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: '12345',
      name: 'Migros Vollmilch',
      brand: 'Migros',
      price: { current: 1.95, currency: 'CHF' },
      category: 'Milchprodukte',
      image: 'https://www.migros.ch/image.jpg',
    });
  });

  it('filters products without prices', () => {
    const data: MigrosSearchResponse = {
      products: [
        { id: 1, name: 'Product with price', price: { amount: 5.0, currency: 'CHF' } },
        { id: 2, name: 'Product without price' },
      ],
    };

    const result = parseMigrosSearchResponse(data, 'https://example.com');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Product with price');
  });

  it('parses nutrition data when available', () => {
    const data: MigrosSearchResponse = {
      products: [
        {
          id: 1,
          name: 'Muesli',
          price: { amount: 4.5, currency: 'CHF' },
          nutrition_facts: {
            energy_kcal: 350,
            protein: 10,
            carbohydrates: 60,
            fat: 8,
            fiber: 5,
            sugar: 15,
          },
        },
      ],
    };

    const result = parseMigrosSearchResponse(data, 'https://example.com');

    expect(result[0].nutrition).toEqual({
      energyKcal: 350,
      protein: 10,
      carbs: 60,
      fat: 8,
      fiber: 5,
      sugar: 15,
    });
  });

  it('parses stores response', () => {
    const data = {
      stores: [
        {
          id: 'store-1',
          name: 'Migros Zürich HB',
          city: 'Zürich',
          zip: '8001',
          street: 'Bahnhofstrasse',
          street_number: '1',
          latitude: 47.3769,
          longitude: 8.5417,
          opening_hours: 'Mo-Fr 08:00-20:00',
        },
      ],
    };

    const result = parseMigrosStoresResponse(data, 'https://example.com');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'store-1',
      name: 'Migros Zürich HB',
      address: 'Bahnhofstrasse, 1, 8001, Zürich',
      latitude: 47.3769,
      longitude: 8.5417,
      openingHours: 'Mo-Fr 08:00-20:00',
    });
  });

  it('skips stores without valid coordinates', () => {
    const data = {
      stores: [
        { id: '1', name: 'Valid Store', latitude: 47.0, longitude: 8.0 },
        { id: '2', name: 'Invalid Store' },
      ],
    };

    const result = parseMigrosStoresResponse(data, 'https://example.com');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Valid Store');
  });
});
