import { NormalizedPrice } from '../adapters/types.js';

export interface CoopSearchResponse {
  products?: CoopProduct[];
  total?: number;
  pagination?: { totalPages?: number; page?: number; pageSize?: number };
}

export interface CoopProduct {
  code: string;
  name: string;
  brandName?: string;
  price?: {
    value: number;
    currencyIso: string;
    formattedValue?: string;
  };
  contentUnit?: string;
  primaryCategory?: { name?: string };
  images?: { url?: string }[];
  url?: string;
  description?: string;
  glutenFree?: boolean;
  lactoseFree?: boolean;
  vegan?: boolean;
  vegetarian?: boolean;
}

export interface CoopStore {
  vstId?: string;
  name?: string;
  address?: {
    town?: string;
    postalCode?: string;
    line1?: string;
    line2?: string;
  };
  geoPoint?: {
    latitude?: number;
    longitude?: number;
  };
  currentOpeningHours?: string;
}

export interface CoopStoresResponse {
  locations?: CoopStore[];
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

export interface CoopParsedStore {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  openingHours?: string;
  sourceUrl: string;
}

function parsePrice(product: CoopProduct): { current: number; currency: string } | undefined {
  const priceObj = product.price;
  if (!priceObj || typeof priceObj !== 'object') return undefined;
  const amount = typeof priceObj.value === 'number' ? priceObj.value : Number(priceObj.value);
  const currency = typeof priceObj.currencyIso === 'string' ? priceObj.currencyIso : 'CHF';
  if (Number.isFinite(amount) && amount > 0) {
    return { current: amount, currency };
  }
  // Accept zero prices (price on request) with a sentinel
  if (Number.isFinite(amount) && amount === 0) {
    return { current: 0, currency };
  }
  return undefined;
}

function parseUnit(unitStr: string | undefined): { value: number; per: string } | undefined {
  if (typeof unitStr === 'string') {
    const match = unitStr.match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml|cl|stk|piece)/i);
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
    const price = parsePrice(product);
    if (!price) {
      return [];
    }

    const unit = parseUnit(product.contentUnit);
    const image = product.images?.[0]?.url;
    const category = product.primaryCategory?.name;
    const allergens: string[] = [];
    if (product.glutenFree) allergens.push('gluten-free');
    if (product.lactoseFree) allergens.push('lactose-free');
    if (product.vegan) allergens.push('vegan');
    if (product.vegetarian) allergens.push('vegetarian');

    return [
      {
        id: product.code,
        sourceUrl,
        productUrl: product.url || undefined,
        name: product.name,
        brand: product.brandName,
        price,
        unit,
        size: product.contentUnit || undefined,
        category,
        image,
        allergens: allergens.length > 0 ? allergens : undefined,
      },
    ];
  });
}

export function parseCoopStoresResponse(
  data: CoopStoresResponse | CoopStore[],
  _sourceUrl: string
): CoopParsedStore[] {
  let stores: CoopStore[];
  if (Array.isArray(data)) {
    stores = data;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = data as any;
    stores = obj.locations ?? obj.stores ?? obj.results ?? obj.items ?? obj.data ?? [];
  }
  return stores.flatMap((store) => {
    // Support both formats: geoPoint (REST API) and location (store finder)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = store as any;
    const loc = s.location;
    const gp = store.geoPoint as Record<string, unknown> | undefined;

    let lat: number | undefined;
    let lon: number | undefined;

    if (loc && typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
      lat = loc.latitude;
      lon = loc.longitude;
    } else if (gp) {
      lat = typeof gp.latitude === 'number' ? gp.latitude : typeof gp.lat === 'number' ? gp.lat : undefined;
      lon = typeof gp.longitude === 'number' ? gp.longitude : typeof gp.lng === 'number' ? gp.lng : typeof gp.lon === 'number' ? gp.lon : undefined;
    }

    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return [];
    }

    // Support both address formats
    let address: string;
    if (loc && typeof loc.address === 'string') {
      // Store finder format: location.address, location.city, location.zip
      const parts = [loc.address, loc.zip, loc.city].filter(
        (p: unknown): p is string => typeof p === 'string' && p.trim().length > 0
      );
      address = parts.join(', ');
    } else {
      // REST API format: address.line1, address.line2, etc.
      const addr = store.address;
      const parts = [addr?.line1, addr?.line2, addr?.postalCode, addr?.town].filter(
        (p: unknown): p is string => typeof p === 'string' && p.trim().length > 0
      );
      address = parts.join(', ');
    }

    const name = s.storeName ?? store.name ?? 'Unknown Store';

    return [
      {
        id: s.costCenterId ?? store.vstId ?? name,
        name,
        address,
        latitude: lat,
        longitude: lon,
        openingHours: store.currentOpeningHours,
        sourceUrl: _sourceUrl,
      },
    ];
  });
}
