import { NormalizedPrice } from '../adapters/types.js';

export interface MigrosApiProduct {
  id: number;
  article_code?: string;
  name: string;
  brand_name?: string;
  price?: {
    amount?: number;
    currency: string;
    unit?: string;
  };
  category_name?: string;
  category?: string[];
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
  ingredients?: string;
  url?: string;
  quantity?: string;
  migrosId?: string;
}

export interface MigrosSearchResponse {
  products: MigrosApiProduct[];
  total?: number;
  offset?: number;
  limit?: number;
}

export interface MigrosApiStore {
  id: string | number;
  name: string;
  city?: string;
  zip?: string;
  street?: string;
  street_number?: string;
  latitude?: number;
  longitude?: number;
  opening_hours?: string;
  canton?: string;
}

export interface MigrosStoresResponse {
  stores: MigrosApiStore[];
  total?: number;
}

export interface MigrosPromotion {
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

export interface MigrosPromotionsResponse {
  promotions: MigrosPromotion[];
}

export interface MigrosParsedProduct {
  id: string;
  sourceUrl: string;
  productUrl?: string;
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
  size?: string;
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
  ingredients?: string;
}

export interface MigrosParsedStore {
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
  if (typeof value === 'string' && value.length > 0) {
    const match = value.match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml|cl|stk|piece)/i);
    if (match) {
      return { value: Number(match[1]), per: match[2].toLowerCase() };
    }
    // Handle bare unit strings like "l", "kg", "stk" (derive value = 1)
    const bareMatch = value.match(/^(kg|g|l|ml|cl|stk|piece)$/i);
    if (bareMatch) {
      return { value: 1, per: bareMatch[1].toLowerCase() };
    }
  }
  return undefined;
}

export function parseMigrosSearchResponse(
  data: MigrosSearchResponse | MigrosApiProduct[],
  sourceUrl: string
): MigrosParsedProduct[] {
  const products = Array.isArray(data) ? data : data.products ?? [];
  return products.flatMap((product) => {
    const price = parsePrice(product.price);
    if (!price) {
      return [];
    }

    const id = product.article_code ?? String(product.id);
    const unit = parseUnit(product.quantity) ?? parseUnit(product.price?.unit);

    return [
      {
        id,
        sourceUrl,
        productUrl: product.url || undefined,
        name: product.name,
        brand: product.brand_name,
        price,
        unit,
        size: product.quantity || undefined,
        category: product.category_name ?? product.category?.join(' > '),
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
        ingredients: product.ingredients,
      },
    ];
  });
}

export function parseMigrosStoresResponse(
  data: MigrosStoresResponse | MigrosApiStore[],
  _sourceUrl: string
): MigrosParsedStore[] {
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
        id: String(store.id),
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
