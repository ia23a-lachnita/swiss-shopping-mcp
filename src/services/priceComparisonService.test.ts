import { describe, expect, it } from 'vitest';

import {
  Chain,
  ChainAdapter,
  NormalizedProduct,
  NormalizedStore,
  ProductSearchFilters,
  Result,
  StoreAvailabilitySupport,
  StoreProductAvailabilityFilters,
  StoreProductAvailabilityResult,
  StoreSearchFilters,
} from '../adapters/types.js';
import { createDefaultAdapters } from '../adapters/index.js';
import { PriceComparisonService } from './priceComparisonService.js';

function adapterWithProducts(chain: Chain, products: NormalizedProduct[]): ChainAdapter {
  return {
    chain,
    async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
      return { ok: true, data: products.slice(0, filters.limit) };
    },
    async findStores(_filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
      return { ok: true, data: [] };
    },
    getStoreAvailabilitySupport(): StoreAvailabilitySupport {
      return { chain, supported: false };
    },
    async lookupStoreProductAvailability(
      filters: StoreProductAvailabilityFilters,
    ): Promise<Result<StoreProductAvailabilityResult>> {
      return {
        ok: true,
        data: {
          chain,
          storeId: filters.storeId,
          query: filters.query,
          supported: false,
          matches: [],
          isAvailable: false,
        },
      };
    },
  };
}

function product(id: string, chain: Chain, current: number, unit?: { value: number; per: string }): NormalizedProduct {
  return {
    id,
    chain,
    name: id,
    category: 'pantry',
    price: { current, unit },
  };
}

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

  it('supports ranking by unit price', async () => {
    // ottos spaghetti: 1.00 for 500g -> 2.00/kg (cheapest)
    // denner penne: 1.20 for 500g -> 2.40/kg
    // migros pasta: 1.70 for 500g -> 3.40/kg
    const result = await service.comparePrices({
      query: 'pasta',
      comparisonBasis: 'unitPrice',
      chains: ['ottos', 'denner', 'migros'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.comparisonBasis).toBe('unitPrice');
      expect(result.data.cheapestOffer?.product.id).toBe('ottos-pasta-500g');
      expect(result.data.cheapestOffer?.baseUnitPrice).toBe(2);
      expect(result.data.cheapestOffer?.baseUnit).toBe('kg');
    }
  });

  it('defaults to one returned offer per chain but honors limitPerChain alternatives', async () => {
    const customService = new PriceComparisonService([
      adapterWithProducts('migros', [
        product('migros-first', 'migros', 2),
        product('migros-second', 'migros', 3),
      ]),
    ]);

    const defaultResult = await customService.comparePrices({ query: 'pasta' });
    expect(defaultResult.ok).toBe(true);
    if (defaultResult.ok) {
      expect(defaultResult.data.offers.map((offer) => offer.product.id)).toEqual(['migros-first']);
    }

    const result = await customService.comparePrices({
      query: 'pasta',
      limitPerChain: 2,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.offers.map((offer) => offer.product.id)).toEqual(['migros-first', 'migros-second']);
    }
  });

  it('marks mixed or missing unit prices ineligible for unit comparison', async () => {
    const customService = new PriceComparisonService([
      adapterWithProducts('migros', [product('migros-500g', 'migros', 2, { value: 500, per: 'g' })]),
      adapterWithProducts('coop', [product('coop-1kg', 'coop', 3, { value: 1, per: 'kg' })]),
      adapterWithProducts('aldi', [product('aldi-1l', 'aldi', 1, { value: 1, per: 'l' })]),
      adapterWithProducts('denner', [product('denner-no-unit', 'denner', 0.5)]),
    ]);

    const result = await customService.comparePrices({
      query: 'staple',
      comparisonBasis: 'unitPrice',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.comparisonUnit).toBe('kg');
      expect(result.data.cheapestOffer?.product.id).toBe('coop-1kg');
      expect(result.data.cheapestOffer?.comparisonPrice).toBe(3);
      expect(result.data.savingsVsMostExpensive).toBe(1);

      const mixedUnitOffer = result.data.offers.find((offer) => offer.product.id === 'aldi-1l');
      expect(mixedUnitOffer?.comparisonEligible).toBe(false);
      expect(mixedUnitOffer?.ineligibleReason).toContain('not comparable');

      const missingUnitOffer = result.data.offers.find((offer) => offer.product.id === 'denner-no-unit');
      expect(missingUnitOffer?.comparisonEligible).toBe(false);
      expect(missingUnitOffer?.ineligibleReason).toContain('Missing');
    }
  });
});
