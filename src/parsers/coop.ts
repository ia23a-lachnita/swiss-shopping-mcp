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
  originalPrice?: {
    value: number;
    currencyIso: string;
    formattedValue?: string;
  };
  hasPromotion?: boolean;
  discountPercentage?: number;
  listPromotions?: string | string[];
  basePrice?: {
    value: number;
    currencyIso?: string;
  };
  basePriceUnit?: string;
  content?: number;
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
    original?: number;
  };
  unit?: {
    value: number;
    per: string;
  };
  vendorUnitPrice?: {
    value: number;
    unit: string;
    display?: string;
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
  promotionLabel?: string;
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

function parseUnit(unitStr: string | undefined, content?: number | string): { value: number; per: string } | undefined {
  // First try parsing with a number prefix (e.g., "6l", "500g")
  if (typeof unitStr === 'string') {
    const match = unitStr.match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml|cl|stk|piece)/i);
    if (match) {
      return { value: Number(match[1]), per: match[2].toLowerCase() };
    }
  }
  // Combine content + contentUnit (e.g., content=6, contentUnit="l" -> {value:6, per:"l"})
  const contentNum = typeof content === 'number' ? content : typeof content === 'string' ? Number(content) : undefined;
  if (typeof contentNum === 'number' && contentNum > 0 && typeof unitStr === 'string') {
    const bareMatch = unitStr.trim().match(/^(kg|g|l|ml|cl|stk|piece)$/i);
    if (bareMatch) {
      return { value: contentNum, per: bareMatch[1].toLowerCase() };
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

    const unit = parseUnit(product.contentUnit, product.content);
    const image = product.images?.[0]?.url;
    const category = product.primaryCategory?.name;
    
    // Extract vendor per-unit price from basePrice field
    let vendorUnitPrice: { value: number; unit: string; display?: string } | undefined;
    if (product.basePrice && typeof product.basePrice.value === 'number' && product.basePrice.value > 0) {
      vendorUnitPrice = {
        value: product.basePrice.value,
        unit: product.basePriceUnit || '',
        display: product.basePriceUnit ? `${product.basePrice.value}/${product.basePriceUnit}` : undefined,
      };
    }
    
    const allergens: string[] = [];
    if (product.glutenFree) allergens.push('gluten-free');
    if (product.lactoseFree) allergens.push('lactose-free');
    if (product.vegan) allergens.push('vegan');
    if (product.vegetarian) allergens.push('vegetarian');

    // Extract sale/promotion data
    const hasPromotion = product.hasPromotion === true;
    const original = hasPromotion && product.originalPrice && typeof product.originalPrice.value === 'number' && product.originalPrice.value > 0
      ? product.originalPrice.value
      : undefined;
    // listPromotions can be a string or string[] from the Coop API
    const rawPromo = product.listPromotions;
    const promoStr = Array.isArray(rawPromo) ? rawPromo.join(', ') : rawPromo;
    const promotionLabel = promoStr || (hasPromotion && product.discountPercentage ? `${product.discountPercentage}% off` : undefined);

    return [
      {
        id: product.code,
        sourceUrl,
        productUrl: product.url ? `https://www.coop.ch${product.url}` : undefined,
        name: product.name,
        brand: product.brandName,
        price: { ...price, original },
        unit,
        vendorUnitPrice,
        size: (product.content != null && product.contentUnit)
          ? `${product.content}${product.contentUnit}`
          : product.contentUnit || undefined,
        category,
        image,
        allergens: allergens.length > 0 ? allergens : undefined,
        promotionLabel,
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
