import {
  Chain,
  ChainAdapter,
  ChainCatalogData,
  NormalizedProduct,
  NormalizedStore,
  ProductSearchFilters,
  Result,
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
}
