import { NormalizedPrice } from '../adapters/types.js';

export interface CoopSearchResponse {
  products?: CoopProduct[];
  total?: number;
}

export interface CoopProduct {
  id: string;
  name: string;
  brand?: string;
  price?: {
    amount: number;
    currency: string;
    unit?: string;
  };
  category?: string;
  image_url?: string;
  labels?: string[];
  nutrition_facts?: {
    energy_kcal?: number;
    protein?: number;
    carbohydrates?: number;
    fat?: number;
    fiber?: number;
    sugar?: number;
  };
  allergens?: string[];
  url?: string;
  description?: string;
}

export interface CoopStore {
  id: string;
  name: string;
  city?: string;
  zip?: string;
  street?: string;
  street_number?: string;
  latitude?: number;
  longitude?: number;
  opening_hours?: string;
  type?: string;
}

export interface CoopStoresResponse {
  stores: CoopStore[];
  total?: number;
}

export interface CoopPromotion {
  id: string;
  title: string;
  description?: string;
  price?: NormalizedPrice;
  original_price?: number;
  image?: string;
  valid_from?: string;
  valid_until?: string;
  category?: string;
}

export interface CoopParsedProduct {
  id: string;
  sourceUrl: string;
  name: string;
  brand?: string;
  price: {
    current: number;
    currency: string;
  };
  unit?: {
    value: number;
    per: string;
  };
  category?: string;
  image?: string;
  nutrition?: {
    energyKcal?: number;
    protein?: number;
    carbs?: number;
    fat?: number;
    fiber?: number;
    sugar?: number;
  };
  allergens?: string[];
}

export interface CoopParsedStore {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  openingHours?: string;
  sourceUrl: string;
}

function parsePrice(value: unknown): { current: number; currency: string } | undefined {
  if (typeof value === 'object' && value !== null) {
    const priceObj = value as Record<string, unknown>;
    const amount = typeof priceObj.amount === 'number' ? priceObj.amount : Number(priceObj.amount);
    const currency = typeof priceObj.currency === 'string' ? priceObj.currency : 'CHF';
    if (Number.isFinite(amount) && amount > 0) {
      return { current: amount, currency };
    }
  }
  return undefined;
}

function parseUnit(value: unknown): { value: number; per: string } | undefined {
  if (typeof value === 'string') {
    const match = value.match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml|cl|stk|piece)/i);
    if (match) {
      return { value: Number(match[1]), per: match[2].toLowerCase() };
    }
  }
  return undefined;
}

export function parseCoopSearchResponse(
  data: CoopSearchResponse | CoopProduct[],
  sourceUrl: string
): CoopParsedProduct[] {
  const products = Array.isArray(data) ? data : data.products ?? [];
  return products.flatMap((product) => {
    const price = parsePrice(product.price);
    if (!price) {
      return [];
    }

    const unit = parseUnit(product.price?.unit);

    return [
      {
        id: product.id,
        sourceUrl,
        name: product.name,
        brand: product.brand,
        price,
        unit,
        category: product.category,
        image: product.image_url,
        nutrition: product.nutrition_facts
          ? {
              energyKcal: product.nutrition_facts.energy_kcal,
              protein: product.nutrition_facts.protein,
              carbs: product.nutrition_facts.carbohydrates,
              fat: product.nutrition_facts.fat,
              fiber: product.nutrition_facts.fiber,
              sugar: product.nutrition_facts.sugar,
            }
          : undefined,
        allergens: product.allergens,
      },
    ];
  });
}

export function parseCoopStoresResponse(
  data: CoopStoresResponse | CoopStore[],
  _sourceUrl: string
): CoopParsedStore[] {
  const stores = Array.isArray(data) ? data : data.stores ?? [];
  return stores.flatMap((store) => {
    const lat = typeof store.latitude === 'number' ? store.latitude : Number(store.latitude);
    const lon = typeof store.longitude === 'number' ? store.longitude : Number(store.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return [];
    }

    const parts = [store.street, store.street_number, store.zip, store.city].filter(
      (p): p is string => typeof p === 'string' && p.trim().length > 0
    );

    return [
      {
        id: store.id,
        name: store.name,
        address: parts.join(', '),
        latitude: lat,
        longitude: lon,
        openingHours: store.opening_hours,
        sourceUrl: _sourceUrl,
      },
    ];
  });
}
