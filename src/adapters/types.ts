export type Chain = 'migros' | 'coop' | 'aldi' | 'denner' | 'lidl' | 'farmy' | 'volg' | 'ottos';
export type SourceCapability =
  | 'productSearch'
  | 'promotions'
  | 'storeSearch'
  | 'availability'
  | 'nutrition';
export type DietaryPreference = 'vegan' | 'vegetarian' | 'gluten-free';
export type ProductMatchMode = 'balanced' | 'literal';
export type PriceComparisonBasis = 'packPrice' | 'unitPrice';
export type MatchMode = ProductMatchMode;
export type ComparisonBasis = PriceComparisonBasis;

export type SourceType =
  | 'official-api'
  | 'partner-api'
  | 'retailer-web'
  | 'third-party'
  | 'open-data';
export type SourceFreshness = 'live' | 'cached' | 'stale';
export type SourceConfidence = 'high' | 'medium' | 'low';
export type MatchExplanationField =
  | 'name'
  | 'brand'
  | 'category'
  | 'tag'
  | 'taxonomy'
  | 'barcode'
  | 'provider-rank';

export enum SourceWarningCode {
  RealSourceNotImplemented = 'REAL_SOURCE_NOT_IMPLEMENTED',
  SourceUnavailable = 'SOURCE_UNAVAILABLE',
  SourceRateLimited = 'SOURCE_RATE_LIMITED',
  SourceParseFailed = 'SOURCE_PARSE_FAILED',
  SourceStaleCacheUsed = 'SOURCE_STALE_CACHE_USED',
  SourceTermsBlocked = 'SOURCE_TERMS_BLOCKED',
}

export interface SourceProvenance {
  provider: string;
  chain?: Chain;
  sourceType: SourceType;
  sourceUrl?: string;
  observedAt: string;
  freshness: SourceFreshness;
  cacheExpiresAt?: string;
  confidence: SourceConfidence;
}

export interface MatchExplanation {
  strength: number;
  matchedBy: MatchExplanationField[];
  matchedTerms: string[];
}

export interface SourceWarning {
  code: SourceWarningCode;
  message: string;
  chain?: Chain;
  provider?: string;
  sourceUrl?: string;
  observedAt?: string;
}

export interface SourceStatus {
  chain: Chain;
  status:
    | 'static-v1'
    | 'source-auditing'
    | 'blocked'
    | 'fixture-backed'
    | 'live-beta'
    | 'live-stable'
    | 'degraded';
  provider?: string;
  sourceType?: SourceType;
  lastObservedAt?: string;
  warning?: SourceWarning;
}

export interface CapabilitySourceStatus {
  chain: Chain;
  capability: SourceCapability;
  status: 'unsupported' | 'blocked' | 'source-auditing' | 'live-beta' | 'live-stable' | 'degraded';
  provider?: string;
  sourceType?: SourceType;
  sourceUrl?: string;
  lastObservedAt?: string;
  warning?: SourceWarning;
  reason?: string;
}

export interface ResultMetadata {
  sourceWarnings?: SourceWarning[];
  sources?: SourceStatus[];
  summary?: string;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface NormalizedPrice {
  current: number;
  original?: number;
  unit?: {
    value: number;
    per: string; // e.g., "100g", "1l", "piece"
  };
}

export interface NormalizedProduct {
  id: string;
  chain: Chain;
  name: string;
  brand?: string;
  price: NormalizedPrice;
  category?: string;
  size?: string;
  image?: string;
  productUrl?: string;
  tags?: string[]; // e.g., "organic", "vegan", "budget"
  nutrition?: {
    energyKcal?: number;
    protein?: number;
    carbs?: number;
    fat?: number;
    fiber?: number;
    sugar?: number;
  };
  allergens?: string[];
  ingredients?: string[];
  provenance?: SourceProvenance;
  matchExplanation?: MatchExplanation;
}

export interface NormalizedStore {
  id: string;
  chain: Chain;
  name: string;
  address: string;
  location: GeoPoint;
  openingHours?: string;
  provenance?: SourceProvenance;
}

export interface NormalizedPromotion {
  id: string;
  chain: Chain;
  title: string;
  productName?: string;
  brand?: string;
  category?: string;
  description?: string;
  image?: string;
  price?: NormalizedPrice;
  originalPrice?: number;
  discount?: {
    type: 'percentage' | 'absolute';
    value: number;
  };
  validFrom: Date;
  validUntil: Date;
  applicableStores?: string[];
  provenance?: SourceProvenance;
}

export interface ProductSearchFilters {
  query: string;
  matchMode?: ProductMatchMode;
  chains?: Chain[];
  maxPrice?: number;
  category?: string;
  tags?: string[];
  excludeAllergens?: string[];
  dietaryPreferences?: DietaryPreference[];
  limit?: number;
}

export interface StoreSearchFilters {
  location: string;
  chains?: Chain[];
  limit?: number;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
}

export interface PriceComparisonFilters {
  query: string;
  matchMode?: ProductMatchMode;
  comparisonBasis?: PriceComparisonBasis;
  includePromotions?: boolean;
  chains?: Chain[];
  maxPrice?: number;
  quantity?: number;
  limitPerChain?: number;
}

export interface PromotionSearchFilters {
  query: string;
  matchMode?: ProductMatchMode;
  chains?: Chain[];
  maxPrice?: number;
  category?: string;
  limit?: number;
}

export interface StoreAvailabilitySupport {
  chain: Chain;
  supported: boolean;
  reason?: string;
}

export interface StoreProductAvailabilityFilters {
  query: string;
  storeId: string;
  matchMode?: ProductMatchMode;
}

export interface ProductAvailabilityMatch {
  product: NormalizedProduct;
  available: boolean;
}

export interface StoreProductAvailabilityResult {
  chain: Chain;
  storeId: string;
  query: string;
  supported: boolean;
  reason?: string;
  matches: ProductAvailabilityMatch[];
  isAvailable: boolean;
}

export interface StoreAvailabilityByLocationFilters {
  query: string;
  location: string;
  chains?: Chain[];
  inStockOnly?: boolean;
  openNow?: boolean;
  limit?: number;
}

export interface StoreWithProductAvailability extends NormalizedStore {
  available: boolean;
  stockCount?: number;
  isOpen?: boolean;
}

export interface ProductAvailabilityResult {
  product: NormalizedProduct;
  stores: StoreWithProductAvailability[];
}

export interface ChainCatalogData {
  products: NormalizedProduct[];
  stores: NormalizedStore[];
  storeInventory?: Record<string, string[]>;
}

export interface ChainAdapter {
  chain: Chain;
  searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>>;
  searchPromotions(filters: PromotionSearchFilters): Promise<Result<NormalizedPromotion[]>>;
  findStores(filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>>;
  getStoreAvailabilitySupport(): StoreAvailabilitySupport;
  lookupStoreProductAvailability(
    filters: StoreProductAvailabilityFilters
  ): Promise<Result<StoreProductAvailabilityResult>>;
}

export type Result<T> =
  | { ok: true; data: T; metadata?: ResultMetadata }
  | { ok: false; error: { code: string; message?: string } };
