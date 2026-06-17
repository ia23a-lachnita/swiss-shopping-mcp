export interface VolgProduct {
  id: string;
  name: string;
  brand?: string;
  price?: {
    amount: number;
    currency: string;
  };
  category?: string;
  image_url?: string;
  url?: string;
  on_sale?: boolean;
}

export interface VolgParsedProduct {
  id: string;
  sourceUrl: string;
  productUrl?: string;
  name: string;
  brand?: string;
  price: {
    current: number;
    currency: string;
  };
  category?: string;
  image?: string;
  tags?: string[];
}

export interface VolgStore {
  id: string;
  name: string;
  city?: string;
  zip?: string;
  street?: string;
  street_number?: string;
  latitude?: number;
  longitude?: number;
  opening_hours?: string;
}

export interface VolgParsedStore {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  openingHours?: string;
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

export function parseVolgSearchResponse(
  data: VolgProduct[],
  sourceUrl: string
): VolgParsedProduct[] {
  return data.flatMap((product) => {
    const price = parsePrice(product.price);
    if (!price) {
      return [];
    }

    return [
      {
        id: product.id,
        sourceUrl,
        name: product.name,
        brand: product.brand,
        price,
        category: product.category,
        image: product.image_url,
        tags: product.on_sale ? ['promotion'] : undefined,
      },
    ];
  });
}

export function parseVolgStoresResponse(
  data: VolgStore[],
  _sourceUrl: string
): VolgParsedStore[] {
  return data.flatMap((store) => {
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
      },
    ];
  });
}

export interface WooCommerceProduct {
  id: number | string;
  name: string;
  permalink?: string;
  prices?: {
    price?: string;
    currency_code?: string;
    currency_minor_unit?: number;
  };
  images?: Array<{ src?: string }>;
  categories?: Array<{ name?: string }>;
  short_description?: string;
  description?: string;
  on_sale?: boolean;
}

function parseWooCommercePrice(prices: unknown): { current: number; currency: string } | undefined {
  if (!prices || typeof prices !== 'object') return undefined;
  const p = prices as Record<string, unknown>;
  const priceStr = typeof p.price === 'string' ? p.price : typeof p.price === 'number' ? String(p.price) : undefined;
  if (!priceStr) return undefined;
  const minorUnit = typeof p.currency_minor_unit === 'number' ? p.currency_minor_unit : 2;
  const amount = Number(priceStr) / Math.pow(10, minorUnit);
  const currency = typeof p.currency_code === 'string' ? p.currency_code : 'CHF';
  if (Number.isFinite(amount) && amount > 0) {
    return { current: amount, currency };
  }
  return undefined;
}

export function parseVolgWooCommerceResponse(
  data: unknown,
  sourceUrl: string
): VolgParsedProduct[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const product = item as Record<string, unknown>;
    const name = typeof product.name === 'string' ? product.name : '';
    if (!name) return [];
    const price = parseWooCommercePrice(product.prices);
    if (!price) return [];
    const images = Array.isArray(product.images) ? product.images : [];
    const categories = Array.isArray(product.categories) ? product.categories : [];
    const image = images.length > 0 && typeof images[0] === 'object' ? (images[0] as Record<string, unknown>).src : undefined;
    const category = categories.length > 0 && typeof categories[0] === 'object' ? (categories[0] as Record<string, unknown>).name : undefined;
    const id = typeof product.id === 'string' ? product.id : String(product.id ?? `volg-${Date.now()}`);
    return [{
      id,
      sourceUrl,
      productUrl: typeof product.permalink === 'string' ? product.permalink : undefined,
      name,
      price,
      category: typeof category === 'string' ? category : undefined,
      image: typeof image === 'string' ? image : undefined,
      tags: product.on_sale === true ? ['promotion'] : undefined,
    }];
  });
}
