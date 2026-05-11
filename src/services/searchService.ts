import {
  ChainAdapter,
  NormalizedProduct,
  NormalizedStore,
  ProductSearchFilters,
  Result,
  StoreSearchFilters,
} from '../adapters/types.js';

function sortProducts(a: NormalizedProduct, b: NormalizedProduct): number {
  if (a.price.current !== b.price.current) {
    return a.price.current - b.price.current;
  }
  return a.name.localeCompare(b.name);
}

function sortStores(a: NormalizedStore, b: NormalizedStore): number {
  return a.name.localeCompare(b.name);
}

export class SearchService {
  private readonly adapters: ChainAdapter[];

  public constructor(adapters: ChainAdapter[]) {
    this.adapters = adapters;
  }

  public async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
    const query = filters.query.trim();
    if (!query) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' } };
    }

    const requestedChains = new Set(filters.chains ?? this.adapters.map((adapter) => adapter.chain));
    const relevantAdapters = this.adapters.filter((adapter) => requestedChains.has(adapter.chain));

    const adapterResults = await Promise.all(
      relevantAdapters.map((adapter) => adapter.searchProducts({ ...filters, query })),
    );

    for (const result of adapterResults) {
      if (!result.ok) {
        return result;
      }
    }

    const products = adapterResults.flatMap((result) => (result.ok ? result.data : []));
    products.sort(sortProducts);

    if (typeof filters.limit === 'number') {
      return { ok: true, data: products.slice(0, filters.limit) };
    }

    return { ok: true, data: products };
  }

  public async findStores(filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
    const location = filters.location.trim();
    if (!location) {
      return {
        ok: false,
        error: { code: 'INVALID_LOCATION', message: 'Location must be a non-empty string.' },
      };
    }

    const requestedChains = new Set(filters.chains ?? this.adapters.map((adapter) => adapter.chain));
    const relevantAdapters = this.adapters.filter((adapter) => requestedChains.has(adapter.chain));

    const adapterResults = await Promise.all(
      relevantAdapters.map((adapter) => adapter.findStores({ ...filters, location })),
    );

    for (const result of adapterResults) {
      if (!result.ok) {
        return result;
      }
    }

    const stores = adapterResults.flatMap((result) => (result.ok ? result.data : []));
    stores.sort(sortStores);

    if (typeof filters.limit === 'number') {
      return { ok: true, data: stores.slice(0, filters.limit) };
    }

    return { ok: true, data: stores };
  }
}
