import {
  ChainAdapter,
  NormalizedProduct,
  NormalizedStore,
  ProductSearchFilters,
  Result,
  SourceProvenance,
  SourceWarningCode,
  StoreAvailabilitySupport,
  StoreProductAvailabilityFilters,
  StoreProductAvailabilityResult,
  StoreSearchFilters,
} from '../types.js';
import { AldiParsedProduct } from '../../parsers/aldi.js';
import { calculateMatchStrength, normalize, sortProducts } from '../../util/matcher.js';

export interface AldiFixtureAdapterOptions {
  products: AldiParsedProduct[];
  observedAt: string;
  cacheExpiresAt?: string;
}

function productProvenance(product: AldiParsedProduct, observedAt: string, cacheExpiresAt?: string): SourceProvenance {
  return {
    provider: 'ALDI SUISSE',
    chain: 'aldi',
    sourceType: 'retailer-web',
    sourceUrl: product.sourceUrl,
    observedAt,
    freshness: 'cached',
    cacheExpiresAt,
    confidence: 'medium',
  };
}

function toNormalizedProduct(
  product: AldiParsedProduct,
  observedAt: string,
  cacheExpiresAt?: string,
): NormalizedProduct {
  return {
    id: product.id,
    chain: 'aldi',
    name: product.name,
    brand: product.brand,
    price: {
      current: product.price.current,
    },
    category: product.category,
    image: product.image,
    tags: product.availability?.endsWith('/InStock') ? ['in-stock'] : undefined,
    provenance: productProvenance(product, observedAt, cacheExpiresAt),
  };
}

export class AldiFixtureAdapter implements ChainAdapter {
  public readonly chain = 'aldi' as const;
  private readonly products: NormalizedProduct[];

  public constructor(options: AldiFixtureAdapterOptions) {
    this.products = options.products.map((product) =>
      toNormalizedProduct(product, options.observedAt, options.cacheExpiresAt),
    );
  }

  public async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
    const query = filters.query.trim();
    if (!query) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' } };
    }

    const matchMode = filters.matchMode ?? 'balanced';
    const requestedTags = (filters.tags ?? []).map((tag) => normalize(tag));

    const products = this.products
      .filter((product) => {
        if (calculateMatchStrength(product, query, matchMode) === 0) {
          return false;
        }

        if (typeof filters.maxPrice === 'number' && product.price.current > filters.maxPrice) {
          return false;
        }

        if (filters.category && normalize(product.category ?? '') !== normalize(filters.category)) {
          return false;
        }

        const productTags = new Set((product.tags ?? []).map((tag) => normalize(tag)));
        return requestedTags.every((tag) => productTags.has(tag));
      })
      .sort((a, b) => sortProducts(a, b, query, matchMode));

    return { ok: true, data: typeof filters.limit === 'number' ? products.slice(0, filters.limit) : products };
  }

  public async findStores(_filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
    return {
      ok: false,
      error: {
        code: SourceWarningCode.RealSourceNotImplemented,
        message: 'Aldi fixture adapter covers product search only; store lookup is not implemented.',
      },
    };
  }

  public getStoreAvailabilitySupport(): StoreAvailabilitySupport {
    return {
      chain: this.chain,
      supported: false,
      reason: 'Aldi fixture adapter does not expose store-level product availability.',
    };
  }

  public async lookupStoreProductAvailability(
    filters: StoreProductAvailabilityFilters,
  ): Promise<Result<StoreProductAvailabilityResult>> {
    return {
      ok: true,
      data: {
        chain: this.chain,
        storeId: filters.storeId,
        query: filters.query,
        supported: false,
        reason: 'Aldi fixture adapter does not expose store-level product availability.',
        matches: [],
        isAvailable: false,
      },
    };
  }
}
