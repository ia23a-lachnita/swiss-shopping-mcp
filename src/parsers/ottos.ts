export interface OttosProduct {
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
  stockLevel?: number;
  description?: string;
}

export interface OttosParsedProduct {
  id: string;
  sourceUrl: string;
  url?: string;
  name: string;
  brand?: string;
  price: {
    current: number;
    currency: string;
  };
  category?: string;
  image?: string;
  stockLevel?: number;
}

export interface OttosStore {
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

export interface OttosParsedStore {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  openingHours?: string;
}

export interface OttosOccProduct {
  code: string;
  name: string;
  url?: string;
  brand?: string;
  price?: { formattedValue?: string };
  images?: Array<{ url?: string }>;
  categories?: Array<{ name?: string }>;
  stockLevel?: number;
  description?: string;
}

export interface OttosOccStore {
  name: string;
  address?: { town?: string; postalCode?: string; line1?: string };
  geoPoint?: { latitude?: number; longitude?: number };
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

function stripHtml(str: string): string {
  return str.replace(/<[^>]*>/g, '').trim();
}

export function parseFormattedPrice(formattedValue: string | undefined): { current: number; currency: string } | undefined {
  if (!formattedValue) return undefined;
  const cleaned = formattedValue.replace(/'/g, '');
  const match = cleaned.match(/(?:CHF|EUR|\$)\s*([\d.,]+)/);
  if (!match) return undefined;
  const amount = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return { current: amount, currency: 'CHF' };
}

export function parseOttosOccProduct(product: OttosOccProduct, sourceUrl: string): OttosParsedProduct | undefined {
  const price = parseFormattedPrice(product.price?.formattedValue);
  if (!price) return undefined;

  const rawImage = product.images?.[0]?.url;
  const image = rawImage?.startsWith('/') ? `https://api.sherpaoutdoor.com${rawImage}` : rawImage;

  return {
    id: product.code,
    sourceUrl,
    url: product.url,
    name: stripHtml(product.name),
    brand: product.brand,
    price,
    category: product.categories?.[0]?.name,
    image,
    stockLevel: product.stockLevel,
  };
}

export function parseOttosOccStore(store: OttosOccStore, index: number, _sourceUrl: string): OttosParsedStore | undefined {
  const lat = typeof store.geoPoint?.latitude === 'number' ? store.geoPoint.latitude : Number(store.geoPoint?.latitude);
  const lon = typeof store.geoPoint?.longitude === 'number' ? store.geoPoint.longitude : Number(store.geoPoint?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;

  const parts = [store.address?.line1, store.address?.postalCode, store.address?.town].filter(
    (p): p is string => typeof p === 'string' && p.trim().length > 0
  );

  // Use address-based name if store.name is just a number (e.g., "0259")
  const storeName = store.name && /^\d+$/.test(store.name) && store.address?.town
    ? `Otto's ${store.address.town}`
    : store.name;

  return {
    id: `ottos-store-${index}`,
    name: storeName,
    address: parts.join(', '),
    latitude: lat,
    longitude: lon,
    openingHours: store.openingHours,
  };
}

export function parseOttosSearchResponse(
  data: OttosProduct[],
  sourceUrl: string
): OttosParsedProduct[] {
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
        stockLevel: product.stockLevel,
      },
    ];
  });
}

export function parseOttosProductPage(
  html: string,
  sourceUrl: string
): OttosParsedProduct | undefined {
  const nameMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const priceMatch = html.match(/CHF\s*(\d+[.,]\d{2})/);
  const imgMatch = html.match(/src=["']([^"']*product[^"']*)["']/i);
  const brandMatch = html.match(/class=["'][^"']*brand[^"']*["'][^>]*>([\s\S]*?)<\//i);
  const categoryMatch = html.match(/class=["'][^"']*category[^"']*["'][^>]*>([\s\S]*?)<\//i);
  const stockMatch = html.match(/stockLevel["']\s*:\s*(\d+)/i);

  const name = nameMatch?.[1]?.replace(/<[^>]*>/g, '').trim();
  const priceStr = priceMatch?.[1]?.replace(',', '.');

  if (!name || !priceStr) {
    return undefined;
  }

  const priceNum = Number(priceStr);
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    return undefined;
  }

  const urlPath = new URL(sourceUrl).pathname.split('/').filter(Boolean);
  const id = urlPath.at(-1) ?? `ottos-${Date.now()}`;

  return {
    id,
    sourceUrl,
    name,
    brand: brandMatch?.[1]?.replace(/<[^>]*>/g, '').trim(),
    price: { current: priceNum, currency: 'CHF' },
    category: categoryMatch?.[1]?.replace(/<[^>]*>/g, '').trim(),
    image: imgMatch?.[1],
    stockLevel: stockMatch?.[1] ? Number(stockMatch[1]) : undefined,
  };
}

export function parseOttosStoresResponse(
  data: OttosStore[],
  _sourceUrl: string
): OttosParsedStore[] {
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
