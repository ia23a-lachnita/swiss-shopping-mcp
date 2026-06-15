import { CapabilitySourceStatus, NormalizedProduct, ProductSearchFilters, Result } from '../adapters/types.js';

export interface ProductProvider {
  readonly providerName: string;
  searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>>;
  getCapabilityStatuses(): CapabilitySourceStatus[];
}

export type ProductProviderName = 'none' | 'pepesto' | 'open-data' | 'custom-index';

export function resolveProductProviderName(): ProductProviderName {
  const raw = process.env.SWISS_SHOPPING_PRODUCT_PROVIDER;
  if (
    raw === 'pepesto' ||
    raw === 'open-data' ||
    raw === 'custom-index'
  ) {
    return raw;
  }
  return 'none';
}
