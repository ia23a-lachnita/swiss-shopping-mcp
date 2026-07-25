// Typed client for the existing Node backend (src/web/server.ts).
// Types mirror the server's normalized domain contract (src/adapters/types.ts).

export type Chain = 'migros' | 'coop' | 'aldi' | 'denner' | 'lidl' | 'volg' | 'ottos';

export const ALL_CHAINS: Chain[] = ['migros', 'coop', 'aldi', 'denner', 'lidl', 'volg', 'ottos'];

/** Chains whose adapters can answer per-store availability today. */
export const AVAILABILITY_CHAINS: Chain[] = ['migros', 'coop', 'aldi'];

export const CHAIN_LABELS: Record<Chain, string> = {
  migros: 'Migros',
  coop: 'Coop',
  aldi: 'Aldi',
  denner: 'Denner',
  lidl: 'Lidl',
  volg: 'Volg',
  ottos: "Otto's",
};

export interface Product {
  id: string;
  chain: Chain;
  name: string;
  brand?: string;
  price: { current: number; original?: number; currency?: string };
  category?: string;
  size?: string;
  image?: string;
  productUrl?: string;
  tags?: string[];
  promotionLabel?: string;
  nutrition?: {
    energyKcal?: number;
    protein?: number;
    carbs?: number;
    fat?: number;
    fiber?: number;
    sugar?: number;
  };
  ingredients?: string[];
}

export interface StoreWithAvailability {
  id: string;
  chain: Chain;
  name: string;
  address: string;
  location: { latitude: number; longitude: number };
  openingHours?: string;
  available: boolean;
  availabilitySupported?: boolean;
  availabilityReason?: string;
  stockCount?: number;
  isOpen?: boolean;
}

export interface ProductAvailability {
  product: Product;
  stores: StoreWithAvailability[];
}

export interface SourceWarning {
  chain: string;
  code: string;
  message: string;
}

export interface ApiError {
  code: string;
  message: string;
}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: ApiError;
  metadata?: { sourceWarnings?: SourceWarning[] };
}

async function request<T>(path: string, init?: RequestInit): Promise<ApiEnvelope<T>> {
  const response = await fetch(path, init);
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!body.ok && !body.error) {
    body.error = { code: 'HTTP_' + response.status, message: response.statusText };
  }
  return body;
}

function post<T>(path: string, payload: unknown): Promise<ApiEnvelope<T>> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function searchProducts(params: {
  query: string;
  chains?: Chain[];
  maxPrice?: number;
  limit?: number;
}): Promise<{ products: Product[]; warnings: SourceWarning[] }> {
  const result = await post<Product[]>('/api/search-products', params);
  if (!result.ok) {
    throw new Error(result.error?.message ?? 'Product search failed.');
  }
  return { products: result.data ?? [], warnings: result.metadata?.sourceWarnings ?? [] };
}

export async function productAvailability(params: {
  query: string;
  location: string;
  chains?: Chain[];
  limit?: number;
  /** Raw device GPS position, when available, for more precise nearest-store ranking than the location text's postal-code centroid. */
  latitude?: number;
  longitude?: number;
}): Promise<ProductAvailability[]> {
  const result = await post<ProductAvailability[]>('/api/product-availability', params);
  if (!result.ok) {
    throw new Error(result.error?.message ?? 'Availability lookup failed.');
  }
  return result.data ?? [];
}

export async function checkLocation(query: string): Promise<boolean> {
  const result = await request<{ valid: boolean }>(`/api/geocode-check?q=${encodeURIComponent(query)}`);
  return result.ok ? (result.data?.valid ?? false) : false;
}

export async function reverseGeocode(latitude: number, longitude: number): Promise<string> {
  const result = await request<{ location: string; city: string; zip: string }>(
    `/api/reverse-geocode?lat=${latitude}&lon=${longitude}`
  );
  if (!result.ok || !result.data) {
    throw new Error(result.error?.message ?? 'Could not resolve your position.');
  }
  return result.data.location;
}

export type SourceCapability = 'productSearch' | 'promotions' | 'storeSearch' | 'availability' | 'nutrition';
export type CapabilityStatusValue =
  | 'unsupported'
  | 'blocked'
  | 'source-auditing'
  | 'live-beta'
  | 'live-stable'
  | 'degraded';

export interface CapabilitySourceStatus {
  chain: Chain;
  capability: SourceCapability;
  status: CapabilityStatusValue;
  provider?: string;
  reason?: string;
}

/** Declared support level per chain/capability — hand-maintained, not a live health check. */
export async function sourceStatus(): Promise<CapabilitySourceStatus[]> {
  const result = await request<CapabilitySourceStatus[]>('/api/source-status');
  if (!result.ok || !result.data) {
    throw new Error(result.error?.message ?? 'Could not load source status.');
  }
  return result.data;
}

export interface MetricsSnapshot {
  timestamp: string;
  cacheHits: { fresh: number; needsRefresh: number; staleFallback: number; miss: number };
  latency: { byChain: Record<string, { avg: number; max: number }> };
  hydration: { successes: number; failures: number; notFoundByChain: Record<string, number> };
  catalog: {
    productsByChain: Record<string, number>;
    totalProducts: number;
    totalObservations: number;
  };
}

/** A real live snapshot (per-chain latency, cache/hydration health) — unlike source-status, this changes every request. */
export async function metrics(): Promise<MetricsSnapshot> {
  const result = await request<MetricsSnapshot>('/api/metrics');
  if (!result.ok || !result.data) {
    throw new Error(result.error?.message ?? 'Could not load metrics.');
  }
  return result.data;
}

export interface ChainPriceOffer {
  chain: Chain;
  product: Product;
  effectivePrice: number;
  unitPrice?: number;
  totalPrice: number;
  comparisonUnit?: string;
  comparisonEligible: boolean;
  ineligibleReason?: string;
}

export interface PriceComparisonResult {
  query: string;
  quantity: number;
  offers: ChainPriceOffer[];
  cheapestOffer?: ChainPriceOffer;
  savingsVsMostExpensive?: number;
}

export async function comparePrices(params: {
  query: string;
  chains?: Chain[];
  quantity?: number;
}): Promise<PriceComparisonResult> {
  const result = await post<PriceComparisonResult>('/api/compare-prices', params);
  if (!result.ok || !result.data) {
    throw new Error(result.error?.message ?? 'Price comparison failed.');
  }
  return result.data;
}
