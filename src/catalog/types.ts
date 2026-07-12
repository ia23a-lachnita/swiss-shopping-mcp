import type { Chain } from '../adapters/types.js';

export type ProductStatus = 'active' | 'suspected_removed' | 'removed';

export interface CatalogProduct {
  chain: Chain;
  productId: string;
  name: string;
  brand: string | null;
  category: string | null;
  description: string | null;
  canonicalUrl: string | null;
  packageSize: string | null;
  language: string | null;
  status: ProductStatus;
  consecutiveFailures: number;
  goneSignals: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastVerifiedAt: string | null;
  metadata: string | null;
}

export interface ProductObservation {
  id: number;
  chain: Chain;
  productId: string;
  price: number | null;
  promotionPrice: number | null;
  currency: string | null;
  availability: string | null;
  observedAt: string;
  source: string | null;
}

export interface CatalogSearchResult {
  product: CatalogProduct;
  score: number;
  flagged: boolean;
}

export interface CatalogStats {
  totalProducts: number;
  productsByStatus: Record<ProductStatus, number>;
  productsByChain: Record<string, number>;
  totalObservations: number;
}

export interface CatalogPriceHistory {
  price: number | null;
  promotionPrice: number | null;
  currency: string | null;
  observedAt: string;
  source: string | null;
}
