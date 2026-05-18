import { describe, expect, it } from 'vitest';

import { createDefaultAdapters } from '../adapters/index.js';
import { SearchService } from './searchService.js';

describe('SearchService', () => {
  const service = new SearchService(createDefaultAdapters());

  it('searches across chains and returns price-sorted products', async () => {
    const result = await service.searchProducts({ query: 'pantry' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.length).toBeGreaterThanOrEqual(5);
      expect(result.data[0].chain).toBe('ottos');
      expect(result.data[1].chain).toBe('lidl');
    }
  });

  it('supports chain-restricted product search', async () => {
    const result = await service.searchProducts({
      query: 'milk',
      chains: ['migros'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].chain).toBe('migros');
    }
  });

  it('uses balanced matching by default for generic product families', async () => {
    const result = await service.searchProducts({ query: 'pasta' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((product) => product.id)).toEqual([
        'migros-pasta-500g',
        'ottos-pasta-500g',
        'denner-pasta-500g',
      ]);
    }
  });

  it('can preserve literal product matching when requested', async () => {
    const result = await service.searchProducts({ query: 'pasta', matchMode: 'literal' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((product) => product.id)).toEqual(['migros-pasta-500g']);
    }
  });

  it('returns an explicit error when query is empty', async () => {
    const result = await service.searchProducts({ query: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_QUERY');
    }
  });

  it('finds stores across matching chains', async () => {
    const result = await service.findStores({ location: 'zürich' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((store) => store.chain)).toEqual(['farmy', 'migros']);
    }
  });

  it('returns an explicit error when store location is empty', async () => {
    const result = await service.findStores({ location: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_LOCATION');
    }
  });

  it('lists store availability support across chains', () => {
    const result = service.getStoreAvailabilitySupport(['migros', 'coop']);
    expect(result).toEqual([
      { chain: 'coop', supported: false, reason: expect.any(String) },
      { chain: 'migros', supported: true },
    ]);
  });

  it('looks up product availability for a specific store', async () => {
    const result = await service.lookupStoreProductAvailability('migros', {
      storeId: 'migros-zurich-1',
      query: 'milk',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.supported).toBe(true);
      expect(result.data.isAvailable).toBe(true);
    }
  });

  it('returns unsupported availability metadata for chains without stock support', async () => {
    const result = await service.lookupStoreProductAvailability('coop', {
      storeId: 'coop-basel-1',
      query: 'milk',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.supported).toBe(false);
      expect(result.data.reason).toBeTruthy();
    }
  });

  it('returns explicit error for missing store in availability lookup', async () => {
    const result = await service.lookupStoreProductAvailability('migros', {
      storeId: 'missing-store',
      query: 'milk',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STORE_NOT_FOUND');
    }
  });
});
