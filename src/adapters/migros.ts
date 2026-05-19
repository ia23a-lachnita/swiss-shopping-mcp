import { fetchJson, HttpError } from '../util/http.js';
import {
  Chain,
  ChainAdapter,
  NormalizedProduct,
  NormalizedStore,
  ProductSearchFilters,
  PromotionSearchFilters,
  Result,
  StoreAvailabilitySupport,
  StoreProductAvailabilityFilters,
  StoreProductAvailabilityResult,
  StoreSearchFilters,
} from './types.js';

const BASE_URL = 'https://api.migros.ch';

interface MigrosPrice {
  value?: number;
  display_value?: number;
  unit?: string;
  display_unit?: string;
}

interface MigrosCategory {
  name?: string;
}

interface MigrosNutrition {
  energy_kcal?: number;
  proteins?: number;
  carbohydrates?: number;
  fat?: number;
  fiber?: number;
  sugar?: number;
}

interface MigrosProduct {
  id?: string;
  name?: string;
  brand?: string;
  offer?: MigrosPrice;
  categories?: MigrosCategory[];
  image_url?: string;
  quantity?: string;
  tags?: string[];
  nutritional_values?: MigrosNutrition;
  allergens?: string[];
}

interface MigrosProductSearchResponse {
  products?: MigrosProduct[];
  total_count?: number;
}

interface MigrosStore {
  id?: string;
  name?: string;
  address?: {
    street?: string;
    city?: string;
    zip?: string;
  };
  geo?: {
    lat?: number;
    lng?: number;
  };
  opening_hours?: {
    text?: string;
  };
}

interface MigrosStoreSearchResponse {
  stores?: MigrosStore[];
}

function normalizeProduct(raw: MigrosProduct, chain: Chain): NormalizedProduct | null {
  if (!raw.id || !raw.name) return null;

  const price = raw.offer?.value ?? 0;
  const unitValue = raw.offer?.display_value;
  const unitPer = raw.offer?.display_unit;

  return {
    id: raw.id,
    chain,
    name: raw.name,
    brand: raw.brand,
    price: {
      current: price,
      unit:
        unitValue !== undefined && unitPer !== undefined
          ? { value: unitValue, per: unitPer }
          : undefined,
    },
    category: raw.categories?.[0]?.name,
    size: raw.quantity,
    image: raw.image_url,
    tags: raw.tags,
    nutrition: raw.nutritional_values
      ? {
          energyKcal: raw.nutritional_values.energy_kcal,
          protein: raw.nutritional_values.proteins,
          carbs: raw.nutritional_values.carbohydrates,
          fat: raw.nutritional_values.fat,
          fiber: raw.nutritional_values.fiber,
          sugar: raw.nutritional_values.sugar,
        }
      : undefined,
    allergens: raw.allergens,
  };
}

function normalizeStore(raw: MigrosStore, chain: Chain): NormalizedStore | null {
  if (!raw.id || !raw.name) return null;

  const lat = raw.geo?.lat;
  const lng = raw.geo?.lng;
  if (lat === undefined || lng === undefined) return null;

  const street = raw.address?.street ?? '';
  const zip = raw.address?.zip ?? '';
  const city = raw.address?.city ?? '';
  const address = [street, `${zip} ${city}`.trim()].filter(Boolean).join(', ');

  return {
    id: raw.id,
    chain,
    name: raw.name,
    address,
    location: { latitude: lat, longitude: lng },
    openingHours: raw.opening_hours?.text,
  };
}

function toFetchError(err: unknown): Result<never> {
  if (err instanceof HttpError) {
    return { ok: false, error: { code: `HTTP_${err.status}`, message: err.message } };
  }
  return {
    ok: false,
    error: { code: 'FETCH_ERROR', message: err instanceof Error ? err.message : String(err) },
  };
}

export class MigrosAdapter implements ChainAdapter {
  readonly chain = 'migros' as const;

  async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
    const { query, limit } = filters;
    const url = `${BASE_URL}/v3/products/search?q=${encodeURIComponent(query)}&lang=de&limit=${limit ?? 20}`;

    try {
      const data = await fetchJson<MigrosProductSearchResponse>(url);
      const products = (data.products ?? [])
        .map((p) => normalizeProduct(p, this.chain))
        .filter((p): p is NormalizedProduct => p !== null);
      return { ok: true, data: products };
    } catch (err) {
      return toFetchError(err);
    }
  }

  async searchPromotions(_filters: PromotionSearchFilters): Promise<Result<never[]>> {
    return {
      ok: false,
      error: {
        code: 'REAL_SOURCE_NOT_IMPLEMENTED',
        message: 'Migros HTTP adapter does not implement promotions.',
      },
    };
  }

  async findStores(filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
    const { location, limit } = filters;
    const url = `${BASE_URL}/v3/stores?q=${encodeURIComponent(location)}&lang=de${limit !== undefined ? `&limit=${limit}` : ''}`;

    try {
      const data = await fetchJson<MigrosStoreSearchResponse>(url);
      const stores = (data.stores ?? [])
        .map((s) => normalizeStore(s, this.chain))
        .filter((s): s is NormalizedStore => s !== null);
      return { ok: true, data: stores };
    } catch (err) {
      return toFetchError(err);
    }
  }

  getStoreAvailabilitySupport(): StoreAvailabilitySupport {
    return {
      chain: this.chain,
      supported: false,
      reason: 'Store-level availability is not yet implemented in the HTTP adapter.',
    };
  }

  async lookupStoreProductAvailability(
    filters: StoreProductAvailabilityFilters
  ): Promise<Result<StoreProductAvailabilityResult>> {
    return {
      ok: true,
      data: {
        chain: this.chain,
        storeId: filters.storeId,
        query: filters.query,
        supported: false,
        reason: 'Store-level availability is not yet implemented in the HTTP adapter.',
        matches: [],
        isAvailable: false,
      },
    };
  }
}
