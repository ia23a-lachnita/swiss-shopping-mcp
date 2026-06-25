import * as cheerio from 'cheerio';

export interface LidlProduct {
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
  description?: string;
}

export interface LidlParsedProduct {
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
}

export interface LidlStore {
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

export interface LidlParsedStore {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  openingHours?: string;
}

export function parseLidlCampaignProducts(
  data: unknown,
  sourceUrl: string
): LidlParsedProduct[] {
  if (!data || typeof data !== 'object') return [];
  const result = data as Record<string, unknown>;

  // Try common response shapes from Lidl Plus API
  const campaigns = extractCampaigns(result);
  const products: LidlParsedProduct[] = [];

  for (const campaign of campaigns) {
    const items = extractItems(campaign);
    for (const item of items) {
      const parsed = parseCampaignItem(item, sourceUrl);
      if (parsed) {
        products.push(parsed);
      }
    }
  }

  // Also handle direct product arrays (from individual campaign endpoint)
  if (products.length === 0 && Array.isArray(result.products)) {
    for (const item of result.products) {
      const parsed = parseCampaignItem(item as Record<string, unknown>, sourceUrl);
      if (parsed) {
        products.push(parsed);
      }
    }
  }

  return products;
}

function extractCampaigns(data: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(data.campaignGroups)) return data.campaignGroups as Record<string, unknown>[];
  if (Array.isArray(data.campaigns)) return data.campaigns as Record<string, unknown>[];
  if (Array.isArray(data.groups)) return data.groups as Record<string, unknown>[];
  if (Array.isArray(data.data)) return data.data as Record<string, unknown>[];
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  return [];
}

function extractItems(campaign: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(campaign.items)) return campaign.items as Record<string, unknown>[];
  if (Array.isArray(campaign.products)) return campaign.products as Record<string, unknown>[];
  if (Array.isArray(campaign.promotionalItems)) return campaign.promotionalItems as Record<string, unknown>[];
  return [];
}

function parseCampaignItem(item: Record<string, unknown>, sourceUrl: string): LidlParsedProduct | null {
  // Handle both old format (name/title) and new format (title)
  const name = typeof item.title === 'string' ? item.title :
    typeof item.name === 'string' ? item.name :
    typeof item.productName === 'string' ? item.productName : '';

  if (!name) return null;

  const price = extractPrice(item);
  if (!price) return null;

  const id = typeof item.id === 'string' ? item.id :
    typeof item.productId === 'string' ? item.productId :
    typeof item.ean === 'string' ? item.ean :
    `lidl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const image = typeof item.imageUrl === 'string' ? item.imageUrl :
    typeof item.image === 'string' ? item.image :
    typeof item.thumbnail === 'string' ? item.thumbnail : undefined;

  const brand = typeof item.brand === 'string' ? item.brand :
    typeof item.brandName === 'string' ? item.brandName : undefined;

  const category = typeof item.category === 'string' ? item.category :
    typeof item.categoryName === 'string' ? item.categoryName : undefined;

  return {
    id,
    sourceUrl,
    name,
    brand,
    price,
    category,
    image,
  };
}

function extractPrice(item: Record<string, unknown>): { current: number; currency: string } | null {
  // New format: mainPrice.price
  if (typeof item.mainPrice === 'object' && item.mainPrice !== null) {
    const mainPrice = item.mainPrice as Record<string, unknown>;
    if (typeof mainPrice.price === 'number' && mainPrice.price > 0) {
      return { current: mainPrice.price, currency: 'CHF' };
    }
  }
  // Old formats
  if (typeof item.price === 'number' && item.price > 0) {
    return { current: item.price, currency: 'CHF' };
  }
  if (typeof item.price === 'object' && item.price !== null) {
    const priceObj = item.price as Record<string, unknown>;
    const amount = typeof priceObj.amount === 'number' ? priceObj.amount : Number(priceObj.amount);
    const currency = typeof priceObj.currency === 'string' ? priceObj.currency : 'CHF';
    if (Number.isFinite(amount) && amount > 0) {
      return { current: amount, currency };
    }
  }
  if (typeof item.currentPrice === 'number' && item.currentPrice > 0) {
    return { current: item.currentPrice, currency: 'CHF' };
  }
  if (typeof item.salesPrice === 'number' && item.salesPrice > 0) {
    return { current: item.salesPrice, currency: 'CHF' };
  }
  return null;
}

export function parseLidlLeafletProducts(
  html: string,
  sourceUrl: string
): LidlParsedProduct[] {
  const products: LidlParsedProduct[] = [];
  const $ = cheerio.load(html);

  $('[class*="product"]').each((_index, element) => {
    const el = $(element);

    const nameEl = el.find('[class*="title"]');
    const name = nameEl.length > 0 ? nameEl.first().text().trim() : '';

    const fullText = el.text();
    const priceMatch = fullText.match(/(\d+[.,]\d{2})/);
    const price = priceMatch?.[1]?.replace(',', '.');

    if (!name || !price) {
      return;
    }

    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      return;
    }

    const imgEl = el.find('img');
    const image = imgEl.length > 0 ? imgEl.attr('src') : undefined;

    const linkEl = el.find('a');
    const href = linkEl.length > 0 ? linkEl.attr('href') : undefined;

    const id = href
      ? new URL(href, sourceUrl).pathname.split('/').filter(Boolean).at(-1) ?? `lidl-${products.length}`
      : `lidl-${products.length}`;

    products.push({
      id,
      sourceUrl: href ? new URL(href, sourceUrl).toString() : sourceUrl,
      name,
      price: { current: priceNum, currency: 'CHF' },
      image,
    });
  });

  return products;
}

export function parseLidlStoresResponse(
  data: unknown,
  _sourceUrl: string
): LidlParsedStore[] {
  // Handle JSON response from Lidl Plus API
  if (Array.isArray(data)) {
    return data.map((store, index) => parseStoreFromJson(store as Record<string, unknown>, index));
  }
  if (typeof data === 'object' && data !== null) {
    const result = data as Record<string, unknown>;
    const stores = extractStoresFromJson(result);
    return stores.map((store, index) => parseStoreFromJson(store, index));
  }

  // Handle HTML response (legacy fallback)
  if (typeof data === 'string') {
    return parseLidlStoresHtml(data, _sourceUrl);
  }

  return [];
}

function extractStoresFromJson(data: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(data.stores)) return data.stores as Record<string, unknown>[];
  if (Array.isArray(data.data)) return data.data as Record<string, unknown>[];
  if (Array.isArray(data.results)) return data.results as Record<string, unknown>[];
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  return [];
}

function parseStoreFromJson(store: Record<string, unknown>, index: number): LidlParsedStore {
  const name = typeof store.name === 'string' ? store.name :
    typeof store.storeName === 'string' ? store.storeName : `Lidl Store ${index}`;

  // Handle nested location object: { latitude, longitude }
  let lat: number;
  let lon: number;
  if (typeof store.location === 'object' && store.location !== null) {
    const loc = store.location as Record<string, unknown>;
    lat = typeof loc.latitude === 'number' ? loc.latitude : Number(loc.latitude);
    lon = typeof loc.longitude === 'number' ? loc.longitude : Number(loc.longitude);
  } else {
    lat = typeof store.latitude === 'number' ? store.latitude :
      typeof store.lat === 'number' ? store.lat : Number(store.latitude ?? store.lat);
    lon = typeof store.longitude === 'number' ? store.longitude :
      typeof store.lng === 'number' ? store.lng : Number(store.longitude ?? store.lng);
  }

  // Handle flat address string (Lidl Plus API uses plain string)
  let address: string;
  if (typeof store.address === 'string') {
    const parts = [store.address, store.postalCode, store.locality].filter(
      (p): p is string => typeof p === 'string' && p.trim().length > 0
    );
    address = parts.join(', ');
  } else {
    const street = typeof store.street === 'string' ? store.street : '';
    const city = typeof store.city === 'string' ? store.city : '';
    const zip = typeof store.zip === 'string' ? store.zip :
      typeof store.postalCode === 'string' ? store.postalCode : '';
    address = [street, zip, city].filter(Boolean).join(', ');
  }

  const openingHours = typeof store.openingHours === 'string' ? store.openingHours :
    typeof store.hours === 'string' ? store.hours : undefined;

  const id = typeof store.storeKey === 'string' ? store.storeKey :
    typeof store.id === 'string' ? store.id :
    typeof store.storeId === 'string' ? store.storeId : `lidl-store-${index}`;

  return {
    id,
    name,
    address,
    latitude: Number.isFinite(lat) ? lat : 0,
    longitude: Number.isFinite(lon) ? lon : 0,
    openingHours,
  };
}

function parseLidlStoresHtml(html: string, _sourceUrl: string): LidlParsedStore[] {
  const stores: LidlParsedStore[] = [];
  const $ = cheerio.load(html);

  $('[class*="store"]').each((_index, element) => {
    const el = $(element);

    const latAttr = el.attr('data-lat');
    const lngAttr = el.attr('data-lng');
    if (!latAttr || !lngAttr) {
      return;
    }

    const lat = Number(latAttr);
    const lon = Number(lngAttr);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return;
    }

    const nameEl = el.find('[class*="name"]');
    const name = nameEl.length > 0 ? nameEl.first().text().trim() : '';
    if (!name) {
      return;
    }

    const addressEl = el.find('[class*="address"]');
    const address = addressEl.length > 0 ? addressEl.first().text().trim() : '';

    const hoursEl = el.find('[class*="hours"]');
    const openingHours = hoursEl.length > 0 ? hoursEl.first().text().trim() : undefined;

    stores.push({
      id: `lidl-${stores.length}`,
      name,
      address,
      latitude: lat,
      longitude: lon,
      openingHours,
    });
  });

  return stores;
}
