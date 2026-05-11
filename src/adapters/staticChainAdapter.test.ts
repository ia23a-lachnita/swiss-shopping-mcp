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
