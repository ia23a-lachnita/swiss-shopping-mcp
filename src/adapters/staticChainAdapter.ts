import {
  Chain,
  ChainAdapter,
  ChainCatalogData,
  NormalizedProduct,
  NormalizedStore,
  ProductAvailabilityMatch,
  ProductSearchFilters,
  Result,
  StoreAvailabilitySupport,
  StoreProductAvailabilityFilters,
  StoreProductAvailabilityResult,
  StoreSearchFilters,
} from './types.js';

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function includesAllTokens(candidate: string, query: string): boolean {
  const normalizedQuery = normalize(query);
  const tokens = normalizedQuery.split(/\s+/).filter((token) => token.length > 0);
  return tokens.every((token) => candidate.includes(token));
}

function sortProducts(a: NormalizedProduct, b: NormalizedProduct): number {
  if (a.price.current !== b.price.current) {
    return a.price.current - b.price.current;
  }
  return a.name.localeCompare(b.name);
}

const STORE_AVAILABILITY_SUPPORT_BY_CHAIN: Record<Chain, StoreAvailabilitySupport> = {
  migros: { chain: 'migros', supported: true },
  coop: {
    chain: 'coop',
    supported: false,
    reason: 'Store-level product availability is not exposed in this chain adapter.',
  },
  aldi: {
    chain: 'aldi',
    supported: false,
    reason: 'Store-level product availability is not exposed in this chain adapter.',
  },
  denner: {
    chain: 'denner',
    supported: false,
    reason: 'Store-level product availability is not exposed in this chain adapter.',
  },
  lidl: {
    chain: 'lidl',
    supported: false,
    reason: 'Store-level product availability is not exposed in this chain adapter.',
  },
  farmy: {
    chain: 'farmy',
    supported: false,
    reason: 'Store-level product availability is not exposed in this chain adapter.',
  },
  volg: {
    chain: 'volg',
    supported: false,
    reason: 'Store-level product availability is not exposed in this chain adapter.',
  },
  ottos: {
    chain: 'ottos',
    supported: false,
    reason: 'Store-level product availability is not exposed in this chain adapter.',
  },
};

export class StaticChainAdapter implements ChainAdapter {
  public readonly chain: Chain;
  private readonly catalog: ChainCatalogData;

  public constructor(chain: Chain, catalog: ChainCatalogData) {
    this.chain = chain;
    this.catalog = catalog;
  }

  public async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
    const query = filters.query.trim();
    if (!query) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' } };
    }

    const requestedTags = (filters.tags ?? []).map((tag) => normalize(tag));
    const excludedAllergens = new Set((filters.excludeAllergens ?? []).map((allergen) => normalize(allergen)));
    const dietaryPreferences = (filters.dietaryPreferences ?? []).map((preference) => normalize(preference));

    const results = this.catalog.products
      .filter((product) => {
        const searchable = [
          product.name,
          product.brand ?? '',
          product.category ?? '',
          ...(product.tags ?? []),
        ]
          .join(' ')
          .toLowerCase();

        if (!includesAllTokens(searchable, query)) {
          return false;
        }

        if (typeof filters.maxPrice === 'number' && product.price.current > filters.maxPrice) {
          return false;
        }

        if (filters.category && normalize(product.category ?? '') !== normalize(filters.category)) {
          return false;
        }

        const productTags = new Set((product.tags ?? []).map((tag) => normalize(tag)));
        if (requestedTags.some((tag) => !productTags.has(tag))) {
          return false;
        }

        if (dietaryPreferences.some((preference) => !productTags.has(preference))) {
          return false;
        }

        const productAllergens = new Set((product.allergens ?? []).map((allergen) => normalize(allergen)));
        if (Array.from(excludedAllergens).some((allergen) => productAllergens.has(allergen))) {
          return false;
        }

        return true;
      })
      .sort(sortProducts);

    if (typeof filters.limit === 'number') {
      return { ok: true, data: results.slice(0, filters.limit) };
    }

    return { ok: true, data: results };
  }

  public async findStores(filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
    const location = filters.location.trim();
    if (!location) {
      return {
        ok: false,
        error: { code: 'INVALID_LOCATION', message: 'Location must be a non-empty string.' },
      };
    }

    const normalizedLocation = normalize(location);
    const matchingStores = this.catalog.stores.filter((store) => {
      return (
        normalize(store.name).includes(normalizedLocation) ||
        normalize(store.address).includes(normalizedLocation)
      );
    });

    if (typeof filters.limit === 'number') {
      return { ok: true, data: matchingStores.slice(0, filters.limit) };
    }

    return { ok: true, data: matchingStores };
  }

  public getStoreAvailabilitySupport(): StoreAvailabilitySupport {
    return STORE_AVAILABILITY_SUPPORT_BY_CHAIN[this.chain];
  }

  public async lookupStoreProductAvailability(
    filters: StoreProductAvailabilityFilters,
  ): Promise<Result<StoreProductAvailabilityResult>> {
    const query = filters.query.trim();
    if (!query) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' } };
    }

    const storeId = filters.storeId.trim();
    if (!storeId) {
      return { ok: false, error: { code: 'INVALID_STORE_ID', message: 'Store ID must be a non-empty string.' } };
    }

    const store = this.catalog.stores.find((candidate) => candidate.id === storeId);
    if (!store) {
      return {
        ok: false,
        error: { code: 'STORE_NOT_FOUND', message: `Store not found for chain ${this.chain}: ${storeId}` },
      };
    }

    const support = this.getStoreAvailabilitySupport();
    if (!support.supported) {
      return {
        ok: true,
        data: {
          chain: this.chain,
          storeId,
          query,
          supported: false,
          reason: support.reason,
          matches: [],
          isAvailable: false,
        },
      };
    }

    const inventory = new Set(this.catalog.storeInventory?.[storeId] ?? []);
    const matches: ProductAvailabilityMatch[] = this.catalog.products
      .filter((product) => {
        const searchable = [
          product.name,
          product.brand ?? '',
          product.category ?? '',
          ...(product.tags ?? []),
        ]
          .join(' ')
          .toLowerCase();
        return includesAllTokens(searchable, query);
      })
      .sort(sortProducts)
      .map((product) => ({
        product,
        available: inventory.has(product.id),
      }));

    return {
      ok: true,
      data: {
        chain: this.chain,
        storeId,
        query,
        supported: true,
        matches,
        isAvailable: matches.some((match) => match.available),
      },
    };
  }
}
