import { extractTrailingSize } from '../util/productSize.js';

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
  size?: string;
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

/**
 * Otto's OCC opening hours: a structured object, not the string the previous
 * declaration claimed.
 *
 * The claim was never checked — the response is cast, so nothing failed at
 * compile time and the object travelled all the way into `NormalizedStore`,
 * whose contract says `openingHours?: string`. The SPA then called
 * `String.replace` on it and replaced the whole store list with "Network
 * error: str.replace is not a function".
 */
export interface OttosOccOpeningHours {
  weekDayOpeningList?: Array<{
    closed?: boolean;
    weekDay?: string;
    openingTime?: { formattedHour?: string };
    closingTime?: { formattedHour?: string };
  }>;
}

export interface OttosOccStore {
  name: string;
  address?: { town?: string; postalCode?: string; line1?: string };
  geoPoint?: { latitude?: number; longitude?: number };
  openingHours?: string | OttosOccOpeningHours;
}

const WEEKDAYS = new Set(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);

/**
 * Renders OCC opening hours as `Mon-Fri: 09:00-19:00, 09:00-20:00 | Sat-Sun:
 * 09:00-17:00` — the format Migros already emits and `isStoreOpen` already
 * parses, including its convention that a section may carry several ranges
 * when the days within it differ (Otto's closes at 20:00 on Thursdays).
 *
 * Returns undefined rather than a placeholder when there is nothing usable:
 * an absent value is honest, an invented one is not.
 */
export function formatOccOpeningHours(
  value: string | OttosOccOpeningHours | undefined
): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  const days = value?.weekDayOpeningList;
  if (!days || days.length === 0) return undefined;

  const collect = (inWeek: boolean): string[] => {
    const ranges: string[] = [];
    for (const day of days) {
      if (day.closed === true || typeof day.weekDay !== 'string') continue;
      if (WEEKDAYS.has(day.weekDay) !== inWeek) continue;
      const open = day.openingTime?.formattedHour;
      const close = day.closingTime?.formattedHour;
      if (!open || !close) continue;
      const range = `${open}-${close}`;
      if (!ranges.includes(range)) ranges.push(range);
    }
    return ranges;
  };

  const sections: string[] = [];
  const weekday = collect(true);
  const weekend = collect(false);
  if (weekday.length > 0) sections.push(`Mon-Fri: ${weekday.join(', ')}`);
  if (weekend.length > 0) sections.push(`Sat-Sun: ${weekend.join(', ')}`);

  return sections.length > 0 ? sections.join(' | ') : undefined;
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

  // The OCC API has no dedicated size/weight field (verified live); pack
  // size only appears embedded in the product name (e.g. "...800 g").
  const { name, size } = extractTrailingSize(stripHtml(product.name));

  return {
    id: product.code,
    sourceUrl,
    url: product.url,
    name,
    brand: product.brand,
    price,
    category: product.categories?.[0]?.name,
    image,
    stockLevel: product.stockLevel,
    size,
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
    openingHours: formatOccOpeningHours(store.openingHours),
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
