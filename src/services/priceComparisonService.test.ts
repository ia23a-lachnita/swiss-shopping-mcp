import { describe, expect, it } from 'vitest';

import { createDefaultAdapters } from '../adapters/index.js';
import { PriceComparisonService } from './priceComparisonService.js';

describe('PriceComparisonService', () => {
  const service = new PriceComparisonService(createDefaultAdapters());

  it('compares prices across chains and computes savings', async () => {
    const result = await service.comparePrices({ query: 'pantry', quantity: 2 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.offers.length).toBeGreaterThanOrEqual(5);
      expect(result.data.cheapestOffer?.chain).toBe('ottos');
      expect(result.data.cheapestOffer?.totalPrice).toBe(2);
      expect(result.data.savingsVsMostExpensive).toBeGreaterThan(0);
    }
  });

  it('supports limiting comparison to selected chains', async () => {
    const result = await service.comparePrices({
      query: 'milk',
      chains: ['migros', 'coop'],
      quantity: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.offers).toHaveLength(2);
      expect(result.data.cheapestOffer?.chain).toBe('migros');
    }
  });

  it('returns an explicit error for invalid quantity', async () => {
    const result = await service.comparePrices({ query: 'milk', quantity: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_QUANTITY');
    }
  });
});
