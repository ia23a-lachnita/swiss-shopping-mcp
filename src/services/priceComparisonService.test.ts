import { describe, expect, it } from 'vitest';

import {
  Chain,
  ChainAdapter,
  NormalizedProduct,
  NormalizedPromotion,
  NormalizedStore,
  ProductSearchFilters,
  PromotionSearchFilters,
  Result,
  ResultMetadata,
  SourceWarningCode,
  StoreAvailabilitySupport,
  StoreProductAvailabilityFilters,
  StoreProductAvailabilityResult,
  StoreSearchFilters,
} from '../adapters/types.js';
import { PriceComparisonService } from './priceComparisonService.js';

function adapterWithProducts(
  chain: Chain,
  products: NormalizedProduct[],
  metadata?: ResultMetadata,
  promotions: NormalizedPromotion[] = []
): ChainAdapter {
  return {
    chain,
    async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
      return { ok: true, data: products.slice(0, filters.limit), metadata };
    },
    async searchPromotions(
      filters: PromotionSearchFilters
    ): Promise<Result<NormalizedPromotion[]>> {
      return { ok: true, data: promotions.slice(0, filters.limit), metadata };
    },
    async findStores(_filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
      return { ok: true, data: [] };
    },
    getStoreAvailabilitySupport(): StoreAvailabilitySupport {
      return { chain, supported: false };
    },
    async lookupStoreProductAvailability(
      filters: StoreProductAvailabilityFilters
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
    async searchPromotions(
      _filters: PromotionSearchFilters
    ): Promise<Result<NormalizedPromotion[]>> {
      return { ok: true, data: [] };
    },
    async findStores(_filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
      return { ok: true, data: [] };
    },
    getStoreAvailabilitySupport(): StoreAvailabilitySupport {
      return { chain, supported: false };
    },
    async lookupStoreProductAvailability(
      filters: StoreProductAvailabilityFilters
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

function product(
  id: string,
  chain: Chain,
  current: number,
  unit?: { value: number; per: string }
): NormalizedProduct {
  return {
    id,
    chain,
    name: id,
    category: 'pantry',
    price: { current, unit },
  };
}

function promotion(
  id: string,
  chain: Chain,
  title: string,
  current: number,
  unit?: { value: number; per: string }
): NormalizedPromotion {
  return {
    id,
    chain,
    title,
    productName: title,
    price: { current, unit },
    validFrom: new Date('2026-05-19T00:00:00.000Z'),
    validUntil: new Date('2026-05-20T23:59:59.999Z'),
  };
}

describe('PriceComparisonService', () => {
  it('compares prices across chains and returns cheapest offer', async () => {
    const service = new PriceComparisonService([
      adapterWithProducts('migros', [product('migros-milk', 'migros', 1.85)]),
      adapterWithProducts('aldi', [product('aldi-milk', 'aldi', 1.5)]),
      adapterWithProducts('coop', [product('coop-milk', 'coop', 2.1)]),
    ]);

    const result = await service.comparePrices({ query: 'milk', quantity: 2 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.offers.length).toBe(3);
      expect(result.data.cheapestOffer?.chain).toBe('aldi');
      expect(result.data.cheapestOffer?.totalPrice).toBe(3);
      expect(result.data.savingsVsMostExpensive).toBeGreaterThan(0);
    }
  });

  it('supports limiting comparison to selected chains', async () => {
    const service = new PriceComparisonService([
      adapterWithProducts('migros', [product('migros-milk', 'migros', 1.85)]),
      adapterWithProducts('coop', [product('coop-milk', 'coop', 2.1)]),
      adapterWithProducts('aldi', [product('aldi-milk', 'aldi', 1.5)]),
    ]);

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
    const service = new PriceComparisonService([
      adapterWithProducts('migros', [
        product('migros-pasta', 'migros', 1.7, { value: 500, per: 'g' }),
      ]),
      adapterWithProducts('aldi', [product('aldi-pasta', 'aldi', 1.0, { value: 500, per: 'g' })]),
      adapterWithProducts('coop', [product('coop-pasta', 'coop', 1.2, { value: 500, per: 'g' })]),
    ]);

    const result = await service.comparePrices({
      query: 'pasta',
      comparisonBasis: 'unitPrice',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.comparisonBasis).toBe('unitPrice');
      expect(result.data.cheapestOffer?.product.id).toBe('aldi-pasta');
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
      expect(result.data.offers.map((offer) => offer.product.id)).toEqual([
        'migros-first',
        'migros-second',
      ]);
    }
  });

  it('keeps promotion offers out by default and ranks them by effective price when requested', async () => {
    const customService = new PriceComparisonService([
      adapterWithProducts(
        'denner',
        [product('denner-orange-juice-static', 'denner', 4)],
        undefined,
        [promotion('denner-orange-juice-promo', 'denner', 'Orange Juice', 2)]
      ),
      adapterWithProducts('coop', [product('coop-orange-juice', 'coop', 3)]),
    ]);

    const defaultResult = await customService.comparePrices({ query: 'orange juice' });
    expect(defaultResult.ok).toBe(true);
    if (defaultResult.ok) {
      expect(defaultResult.data.cheapestOffer?.product.id).toBe('coop-orange-juice');
      expect(defaultResult.data.offers.some((offer) => offer.priceBasis === 'promotion')).toBe(
        false
      );
    }

    const result = await customService.comparePrices({
      query: 'orange juice',
      includePromotions: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.cheapestOffer).toMatchObject({
        chain: 'denner',
        priceBasis: 'promotion',
        effectivePrice: 2,
        totalPrice: 2,
        promotion: { id: 'denner-orange-juice-promo' },
      });
    }
  });

  it('marks mixed or missing unit prices ineligible for unit comparison', async () => {
    const customService = new PriceComparisonService([
      adapterWithProducts('migros', [
        product('migros-500g', 'migros', 2, { value: 500, per: 'g' }),
      ]),
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

      const missingUnitOffer = result.data.offers.find(
        (offer) => offer.product.id === 'denner-no-unit'
      );
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

  it('returns empty data with warnings when every comparison source fails', async () => {
    const customService = new PriceComparisonService([
      failingAdapter('migros', 'HTTP_503'),
      failingAdapter('coop', 'HTTP_429'),
    ]);

    const result = await customService.comparePrices({ query: 'milk' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.offers).toEqual([]);
      expect(result.metadata?.sourceWarnings).toBeDefined();
      expect(result.metadata?.sourceWarnings?.length).toBeGreaterThan(0);
    }
  });
});
