import { describe, expect, it } from 'vitest';

import { STATIC_CHAIN_CATALOG } from './staticCatalog.js';
import { StaticChainAdapter } from './staticChainAdapter.js';

describe('StaticChainAdapter', () => {
  const adapter = new StaticChainAdapter('migros', STATIC_CHAIN_CATALOG.migros);

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
});
