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
