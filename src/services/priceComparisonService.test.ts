import { describe, expect, it } from 'vitest';

import {
  Chain,
  ChainAdapter,
  NormalizedProduct,
  NormalizedStore,
  ProductSearchFilters,
  Result,
  ResultMetadata,
  SourceWarningCode,
  StoreAvailabilitySupport,
  StoreProductAvailabilityFilters,
  StoreProductAvailabilityResult,
  StoreSearchFilters,
} from '../adapters/types.js';
import { createDefaultAdapters } from '../adapters/index.js';
import { PriceComparisonService } from './priceComparisonService.js';

function adapterWithProducts(chain: Chain, products: NormalizedProduct[], metadata?: ResultMetadata): ChainAdapter {
  return {
    chain,
    async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
      return { ok: true, data: products.slice(0, filters.limit), metadata };
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

function failingAdapter(chain: Chain, code: string): ChainAdapter {
  return {
    chain,
    async searchProducts(_filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
      return { ok: false, error: { code, message: `${chain} failed.` } };
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
  const service = new PriceComparisonService(createDefaultAdapters({ dataMode: 'legacy-static' }));

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

  it('returns offers with source warnings when one chain fails', async () => {
    const customService = new PriceComparisonService([
      adapterWithProducts('migros', [product('migros-milk', 'migros', 1)]),
      failingAdapter('coop', 'HTTP_503'),
    ]);

    const result = await customService.comparePrices({ query: 'milk' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.offers.map((offer) => offer.product.id)).toEqual(['migros-milk']);
      expect(result.metadata?.sourceWarnings).toEqual([
        expect.objectContaining({
          chain: 'coop',
          code: 'SOURCE_UNAVAILABLE',
          message: 'coop failed.',
        }),
      ]);
    }
  });

  it('propagates metadata from successful product adapters', async () => {
    const sourceWarning = {
      chain: 'aldi' as const,
      code: SourceWarningCode.SourceStaleCacheUsed,
      message: 'Using stale cache.',
      observedAt: '2026-05-18T10:00:00.000Z',
    };
    const customService = new PriceComparisonService([
      adapterWithProducts('aldi', [product('aldi-bread', 'aldi', 2)], {
        sourceWarnings: [sourceWarning],
        sources: [
          {
            chain: 'aldi',
            status: 'degraded',
            provider: 'ALDI SUISSE',
            sourceType: 'retailer-web',
            lastObservedAt: '2026-05-18T10:00:00.000Z',
          },
        ],
        summary: 'Aldi cache used.',
      }),
    ]);

    const result = await customService.comparePrices({ query: 'bread' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metadata?.sourceWarnings).toEqual([sourceWarning]);
      expect(result.metadata?.sources?.[0]).toMatchObject({ chain: 'aldi', status: 'degraded' });
      expect(result.metadata?.summary).toBe('Aldi cache used.');
    }
  });

  it('returns an all-sources error when every comparison source fails', async () => {
    const customService = new PriceComparisonService([
      failingAdapter('migros', 'HTTP_503'),
      failingAdapter('coop', 'HTTP_429'),
    ]);

    const result = await customService.comparePrices({ query: 'milk' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ALL_SOURCES_FAILED');
      expect(result.error.message).toContain('migros');
      expect(result.error.message).toContain('coop');
    }
  });
});
