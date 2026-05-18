import { describe, expect, it } from 'vitest';

import { STATIC_CHAIN_CATALOG } from './staticCatalog.js';
import { StaticChainAdapter } from './staticChainAdapter.js';

describe('StaticChainAdapter', () => {
  const adapter = new StaticChainAdapter('migros', STATIC_CHAIN_CATALOG.migros);
  const unsupportedAdapter = new StaticChainAdapter('coop', STATIC_CHAIN_CATALOG.coop);

  it('returns an explicit error for empty search query', async () => {
    const result = await adapter.searchProducts({ query: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_QUERY');
    }
  });

  it('searches products by query tokens and applies filters', async () => {
    const result = await adapter.searchProducts({
      query: 'whole milk',
      maxPrice: 2,
      tags: ['organic'],
      excludeAllergens: ['gluten'],
      dietaryPreferences: ['vegetarian'],
      limit: 5,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('migros-milk-1l');
    }
  });

  it('returns products sorted by price and supports category filtering', async () => {
    const result = await adapter.searchProducts({
      query: 'pasta milk',
      category: 'pantry',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(0);
    }
  });

  it('supports balanced search with taxonomy aliases (e.g., pasta -> spaghetti)', async () => {
    // ottos has "Spaghetti" which is an alias for "pasta" in TAXONOMY
    const ottosAdapter = new StaticChainAdapter('ottos', STATIC_CHAIN_CATALOG.ottos);
    const result = await ottosAdapter.searchProducts({
      query: 'pasta',
      matchMode: 'balanced',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe('Spaghetti');
    }
  });

  it('supports literal search (no taxonomy aliases)', async () => {
    const ottosAdapter = new StaticChainAdapter('ottos', STATIC_CHAIN_CATALOG.ottos);
    const result = await ottosAdapter.searchProducts({
      query: 'pasta',
      matchMode: 'literal',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // "Spaghetti" does not contain the word "pasta"
      expect(result.data).toHaveLength(0);
    }
  });

  it('ranks results by match strength', async () => {
    // Create a custom catalog with different types of matches
    const customAdapter = new StaticChainAdapter('migros', {
      products: [
        {
          id: 'p1',
          chain: 'migros',
          name: 'Wholegrain Pasta', // strength 80 (starts with pasta)
          price: { current: 1.0 },
        },
        {
          id: 'p2',
          chain: 'migros',
          name: 'Pasta', // strength 100 (exact)
          price: { current: 2.0 },
        },
        {
          id: 'p3',
          chain: 'migros',
          name: 'Special Penne', // strength 90 (alias Penne)
          price: { current: 0.5 },
        },
      ],
      stores: [],
    });

    const result = await customAdapter.searchProducts({ query: 'pasta' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0].id).toBe('p2'); // 100
      expect(result.data[1].id).toBe('p1'); // direct name match
      expect(result.data[2].id).toBe('p3'); // taxonomy alias match
    }
  });

  it('returns an explicit error for empty store location', async () => {
    const result = await adapter.findStores({ location: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_LOCATION');
    }
  });

  it('finds stores by city or address token', async () => {
    const result = await adapter.findStores({ location: 'zürich' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('migros-zurich-1');
    }
  });

  it('reports support status for store-level availability lookups', () => {
    expect(adapter.getStoreAvailabilitySupport()).toEqual({ chain: 'migros', supported: true });
    expect(unsupportedAdapter.getStoreAvailabilitySupport()).toEqual({
      chain: 'coop',
      supported: false,
      reason: expect.any(String),
    });
  });

  it('returns availability matches for supported chains', async () => {
    const result = await adapter.lookupStoreProductAvailability({
      storeId: 'migros-zurich-1',
      query: 'milk',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.supported).toBe(true);
      expect(result.data.isAvailable).toBe(true);
      expect(result.data.matches).toHaveLength(1);
      expect(result.data.matches[0].available).toBe(true);
      expect(result.data.matches[0].product.id).toBe('migros-milk-1l');
    }
  });

  it('does not mark availability true from a broad alias when an exact product match is unavailable', async () => {
    const customAdapter = new StaticChainAdapter('migros', {
      products: [
        {
          id: 'exact-pasta',
          chain: 'migros',
          name: 'Wholegrain Pasta',
          category: 'pantry',
          price: { current: 1.7, unit: { value: 0.5, per: 'kg' } },
        },
        {
          id: 'alias-penne',
          chain: 'migros',
          name: 'Penne Rigate',
          category: 'pantry',
          price: { current: 1.2, unit: { value: 0.5, per: 'kg' } },
        },
      ],
      stores: [
        {
          id: 'store-1',
          chain: 'migros',
          name: 'Migros Test',
          address: 'Teststrasse 1, 8000 Zürich',
          location: { latitude: 47.37, longitude: 8.54 },
        },
      ],
      storeInventory: {
        'store-1': ['alias-penne'],
      },
    });

    const result = await customAdapter.lookupStoreProductAvailability({
      storeId: 'store-1',
      query: 'pasta',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.matches.map((match) => match.product.id)).toEqual(['exact-pasta', 'alias-penne']);
      expect(result.data.matches.find((match) => match.product.id === 'alias-penne')?.available).toBe(true);
      expect(result.data.isAvailable).toBe(false);
    }
  });

  it('returns unsupported result when chain does not expose availability', async () => {
    const result = await unsupportedAdapter.lookupStoreProductAvailability({
      storeId: 'coop-basel-1',
      query: 'milk',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.supported).toBe(false);
      expect(result.data.isAvailable).toBe(false);
      expect(result.data.matches).toHaveLength(0);
      expect(result.data.reason).toBeTruthy();
    }
  });

  it('returns explicit errors for invalid availability lookups', async () => {
    const invalidStoreIdResult = await adapter.lookupStoreProductAvailability({
      storeId: '   ',
      query: 'milk',
    });
    expect(invalidStoreIdResult.ok).toBe(false);
    if (!invalidStoreIdResult.ok) {
      expect(invalidStoreIdResult.error.code).toBe('INVALID_STORE_ID');
    }

    const missingStoreResult = await adapter.lookupStoreProductAvailability({
      storeId: 'migros-zurich-missing',
      query: 'milk',
    });
    expect(missingStoreResult.ok).toBe(false);
    if (!missingStoreResult.ok) {
      expect(missingStoreResult.error.code).toBe('STORE_NOT_FOUND');
    }
  });
});
