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
});
