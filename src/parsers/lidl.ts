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
  html: string,
  _sourceUrl: string
): LidlParsedStore[] {
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
