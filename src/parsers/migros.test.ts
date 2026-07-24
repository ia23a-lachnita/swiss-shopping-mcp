import { describe, expect, it } from 'vitest';

import {
  MigrosApiProduct,
  MigrosSearchResponse,
  parseMigrosSearchResponse,
  parseMigrosStoresResponse,
  toParsedMigrosPromotion,
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

  describe('toParsedMigrosPromotion', () => {
    const campaignWindow = { startDate: '2026-07-23', endDate: '2026-07-29' };

    it('builds a promotion from a discounted product card', () => {
      // Real shape verified live: normalizeProductDetail() already derives
      // price.amount (promo price) / price.original (regular price) from
      // offer.promotionPrice / offer.price when a discount is active.
      const product: MigrosApiProduct = {
        id: 100038355,
        name: 'Königssalat',
        brand_name: 'Migros',
        category_name: 'Salat',
        image_url: 'https://image.migros.ch/koenigssalat.jpg',
        quantity: '150g',
        price: { amount: 3.2, original: 3.7, currency: 'CHF' },
        url: 'https://www.migros.ch/de/product/100038355',
      };

      const result = toParsedMigrosPromotion(product, campaignWindow, 'https://www.migros.ch/promo-search');

      expect(result).toMatchObject({
        id: '100038355',
        title: 'Königssalat',
        brand: 'Migros',
        category: 'Salat',
        description: '150g',
        price: { current: 3.2 },
        originalPrice: 3.7,
        discount: { type: 'percentage', value: 14 },
        validFrom: '2026-07-23',
        validUntil: '2026-07-29',
      });
    });

    it('returns undefined for a product with no active discount', () => {
      const product: MigrosApiProduct = {
        id: 1,
        name: 'Regular Product',
        price: { amount: 5.0, currency: 'CHF' },
      };

      expect(toParsedMigrosPromotion(product, campaignWindow, 'https://example.com')).toBeUndefined();
    });

    it('returns undefined when original price is not actually higher than current', () => {
      const product: MigrosApiProduct = {
        id: 1,
        name: 'Suspicious Product',
        price: { amount: 5.0, original: 5.0, currency: 'CHF' },
      };

      expect(toParsedMigrosPromotion(product, campaignWindow, 'https://example.com')).toBeUndefined();
    });
  });
});
