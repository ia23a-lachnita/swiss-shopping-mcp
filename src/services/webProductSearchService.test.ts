import { describe, expect, it, vi } from 'vitest';

import { FileTtlCache } from '../cache/fileTtlCache.js';
import { WebSearchProvider, WebSearchResult } from '../sources/webSearch.js';
import {
  Chain,
  ChainAdapter,
  NormalizedProduct,
  Result,
  SourceWarningCode,
} from '../adapters/types.js';
import { WebProductSearchService } from './webProductSearchService.js';

function createMockCache(): FileTtlCache & { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue({ expiresAt: '2099-01-01T00:00:00.000Z' }),
  } as unknown as FileTtlCache & { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
}

function stubProvider(resultsBySite: Record<string, WebSearchResult[]>): WebSearchProvider & {
  search: ReturnType<typeof vi.fn>;
} {
  return {
    name: 'ddg',
    search: vi.fn(async (_query: string, options: { site: string }) => {
      return resultsBySite[options.site] ?? [];
    }),
  } as unknown as WebSearchProvider & { search: ReturnType<typeof vi.fn> };
}

function product(id: string, chain: Chain, price = 2.5): NormalizedProduct {
  return { id, chain, name: `Product ${id}`, price: { current: price } };
}

function hydratableAdapter(
  chain: Chain,
  productsById: Record<string, NormalizedProduct>
): ChainAdapter & { getProductsByIds: ReturnType<typeof vi.fn> } {
  return {
    chain,
    searchProducts: vi.fn(),
    searchPromotions: vi.fn(),
    findStores: vi.fn(),
    getStoreAvailabilitySupport: vi.fn(),
    lookupStoreProductAvailability: vi.fn(),
    getProductsByIds: vi.fn(async (ids: string[]): Promise<Result<NormalizedProduct[]>> => {
      return { ok: true, data: ids.map((id) => productsById[id]).filter(Boolean) };
    }),
  } as unknown as ChainAdapter & { getProductsByIds: ReturnType<typeof vi.fn> };
}

function plainAdapter(chain: Chain): ChainAdapter {
  return {
    chain,
    searchProducts: vi.fn(),
    searchPromotions: vi.fn(),
    findStores: vi.fn(),
    getStoreAvailabilitySupport: vi.fn(),
    lookupStoreProductAvailability: vi.fn(),
  } as unknown as ChainAdapter;
}

function ranked(urls: string[]): WebSearchResult[] {
  return urls.map((url, rank) => ({ url, rank }));
}

describe('WebProductSearchService', () => {
  it('extracts Migros product IDs (including mo/ URLs) and hydrates them in rank order', async () => {
    const adapter = hydratableAdapter('migros', {
      '514160800000': product('514160800000', 'migros'),
      '106497': product('106497', 'migros'),
    });
    const provider = stubProvider({
      'migros.ch/de/product': ranked([
        'https://www.migros.ch/de/product/514160800000?context=ecommerce',
        'https://www.migros.ch/de/product/mo/106497',
        'https://www.migros.ch/de/product/514160800000',
      ]),
    });
    const service = new WebProductSearchService({
      provider,
      adapters: [adapter],
      cache: createMockCache(),
    });

    const result = await service.searchProducts({ query: 'toothpaste sensitive' }, ['migros']);

    expect(adapter.getProductsByIds).toHaveBeenCalledWith(['514160800000', '106497']);
    const migrosProducts = result.productsByChain.get('migros') ?? [];
    expect(migrosProducts.map((p) => p.id)).toEqual(['514160800000', '106497']);
    expect(migrosProducts[0].matchExplanation?.matchedBy).toEqual(['provider-rank']);
    expect(result.warnings).toEqual([]);
  });

  it('extracts Coop product codes from /p/{code} URLs', async () => {
    const adapter = hydratableAdapter('coop', {
      '4940251': product('4940251', 'coop'),
    });
    const provider = stubProvider({
      'coop.ch': ranked([
        'https://www.coop.ch/de/lebensmittel/milchprodukte/x/p/4940251',
        'https://www.coop.ch/de/rezepte/pasta', // no product code -> ignored
      ]),
    });
    const service = new WebProductSearchService({
      provider,
      adapters: [adapter],
      cache: createMockCache(),
    });

    const result = await service.searchProducts({ query: 'milch' }, ['coop']);

    expect(adapter.getProductsByIds).toHaveBeenCalledWith(['4940251']);
    expect(result.productsByChain.get('coop')?.map((p) => p.id)).toEqual(['4940251']);
  });

  it('skips chains without getProductsByIds support', async () => {
    const provider = stubProvider({});
    const service = new WebProductSearchService({
      provider,
      adapters: [plainAdapter('migros'), plainAdapter('aldi')],
      cache: createMockCache(),
    });

    const result = await service.searchProducts({ query: 'milch' }, ['migros', 'aldi']);

    expect(provider.search).not.toHaveBeenCalled();
    expect(result.productsByChain.size).toBe(0);
    expect(service.supportsChain('migros')).toBe(false);
  });

  it('degrades to a warning when the search engine fails', async () => {
    const adapter = hydratableAdapter('migros', {});
    const provider = stubProvider({});
    provider.search.mockRejectedValue(new Error('engine down'));
    const service = new WebProductSearchService({
      provider,
      adapters: [adapter],
      cache: createMockCache(),
    });

    const result = await service.searchProducts({ query: 'milch' }, ['migros']);

    expect(result.productsByChain.size).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe(SourceWarningCode.SourceUnavailable);
    expect(result.warnings[0].message).toContain('engine down');
  });

  it('degrades to a warning when hydration fails', async () => {
    const adapter = hydratableAdapter('migros', {});
    adapter.getProductsByIds.mockResolvedValue({
      ok: false,
      error: { code: SourceWarningCode.SourceUnavailable, message: 'cards endpoint down' },
    });
    const provider = stubProvider({
      'migros.ch/de/product': ranked(['https://www.migros.ch/de/product/514160800000']),
    });
    const service = new WebProductSearchService({
      provider,
      adapters: [adapter],
      cache: createMockCache(),
    });

    const result = await service.searchProducts({ query: 'milch' }, ['migros']);

    expect(result.productsByChain.size).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toContain('cards endpoint down');
  });

  it('applies maxPrice and price>0 filter constraints to hydrated products', async () => {
    const adapter = hydratableAdapter('migros', {
      '1': product('1', 'migros', 3),
      '2': product('2', 'migros', 12),
      '3': product('3', 'migros', 0),
    });
    const provider = stubProvider({
      'migros.ch/de/product': ranked([
        'https://www.migros.ch/de/product/1111',
        'https://www.migros.ch/de/product/2222',
        'https://www.migros.ch/de/product/3333',
      ]),
    });
    adapter.getProductsByIds.mockResolvedValue({
      ok: true,
      data: [product('1', 'migros', 3), product('2', 'migros', 12), product('3', 'migros', 0)],
    });
    const service = new WebProductSearchService({
      provider,
      adapters: [adapter],
      cache: createMockCache(),
    });

    const result = await service.searchProducts({ query: 'milch', maxPrice: 5 }, ['migros']);

    expect(result.productsByChain.get('migros')?.map((p) => p.id)).toEqual(['1']);
  });

  it('reuses cached product-ID lists without hitting the search engine', async () => {
    const adapter = hydratableAdapter('migros', {
      '514160800000': product('514160800000', 'migros'),
    });
    const provider = stubProvider({});
    const cache = createMockCache();
    cache.get.mockResolvedValue({
      data: { ids: ['514160800000'] },
      provenance: {},
      isStale: false,
    });
    const service = new WebProductSearchService({ provider, adapters: [adapter], cache });

    const result = await service.searchProducts({ query: 'milch' }, ['migros']);

    expect(provider.search).not.toHaveBeenCalled();
    expect(result.productsByChain.get('migros')?.map((p) => p.id)).toEqual(['514160800000']);
  });

  it('does not cache empty ID lists', async () => {
    const adapter = hydratableAdapter('migros', {});
    const provider = stubProvider({ 'migros.ch/de/product': [] });
    const cache = createMockCache();
    const service = new WebProductSearchService({ provider, adapters: [adapter], cache });

    const result = await service.searchProducts({ query: 'milch' }, ['migros']);

    expect(result.productsByChain.size).toBe(0);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('caps hydrated IDs at maxProductsPerChain', async () => {
    const adapter = hydratableAdapter('migros', {});
    const provider = stubProvider({
      'migros.ch/de/product': ranked(
        Array.from({ length: 10 }, (_, i) => `https://www.migros.ch/de/product/${100000 + i}`)
      ),
    });
    const service = new WebProductSearchService({
      provider,
      adapters: [adapter],
      cache: createMockCache(),
      maxProductsPerChain: 3,
    });

    await service.searchProducts({ query: 'milch' }, ['migros']);

    expect(adapter.getProductsByIds).toHaveBeenCalledWith(['100000', '100001', '100002']);
  });
});
