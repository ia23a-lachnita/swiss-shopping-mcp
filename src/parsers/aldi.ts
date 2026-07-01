export interface AldiSitemapEntry {
  loc: string;
  lastmod?: string;
}

export interface AldiParsedProduct {
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
  availability?: string;
  tags?: string[];
  productSku?: string;
}

export interface AldiServicePoint {
  id: string;
  name: string;
  latitude?: number;
  longitude?: number;
  isOpenNow?: boolean;
  distance?: string;
  city?: string;
  zip?: string;
  street?: string;
}

export interface AldiAvailabilityResult {
  servicePointReference: string;
  availabilityTrafficLight: string;
  stockInfoDisplay: string;
  servicePointName: string;
  distance?: string;
  isOpenNow?: boolean;
}

interface JsonLdObject {
  '@type'?: string | string[];
  name?: unknown;
  item?: unknown;
  itemListElement?: unknown;
  offers?: unknown;
  image?: unknown;
  brand?: unknown;
}

interface JsonLdListItem {
  '@type'?: string;
  position?: number;
  name?: unknown;
  item?: unknown;
}

interface JsonLdOffer {
  '@type'?: string;
  url?: unknown;
  price?: unknown;
  priceCurrency?: unknown;
  availability?: unknown;
}

interface JsonLdBrand {
  '@type'?: string;
  name?: unknown;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getJsonLdType(value: JsonLdObject): string[] {
  if (Array.isArray(value['@type'])) {
    return value['@type'].filter((entry): entry is string => typeof entry === 'string');
  }
  return typeof value['@type'] === 'string' ? [value['@type']] : [];
}

function extractProductId(sourceUrl: string): string | undefined {
  const productSlug = new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1);
  return productSlug;
}

export function extractProductSku(productId: string): string | undefined {
  const match = productId.match(/(\d{18})$/);
  return match ? match[1] : undefined;
}

export function parseAldiServicePointsResponse(data: unknown): AldiServicePoint[] {
  const response = data as Record<string, unknown>;
  const items = response?.data;
  if (!Array.isArray(items)) return [];

  return items.map((item) => {
    const s = item as Record<string, unknown>;
    const addr = s.address as Record<string, unknown> | undefined;
    return {
      id: String(s.id ?? ''),
      name: String(addr?.address1 ?? s.name ?? ''),
      latitude: typeof addr?.latitude === 'string' ? parseFloat(addr.latitude) : undefined,
      longitude: typeof addr?.longitude === 'string' ? parseFloat(addr.longitude) : undefined,
      isOpenNow: typeof s.isOpenNow === 'boolean' ? s.isOpenNow : undefined,
      distance: typeof s.distance === 'string' ? s.distance : undefined,
      city: typeof addr?.city === 'string' ? addr.city : undefined,
      zip: typeof addr?.zipCode === 'string' ? addr.zipCode : undefined,
      street: typeof addr?.address1 === 'string' ? addr.address1 : undefined,
    };
  });
}

export function parseAldiAvailabilityResponse(data: unknown): AldiAvailabilityResult[] {
  const response = data as Record<string, unknown>;
  const items = response?.data;
  if (!Array.isArray(items)) return [];

  return items.map((item) => {
    const s = item as Record<string, unknown>;
    return {
      servicePointReference: String(s.servicePointReference ?? ''),
      availabilityTrafficLight: String(s.availabilityTrafficLight ?? 'red'),
      stockInfoDisplay: String(s.stockInfoDisplay ?? ''),
      servicePointName: String(s.servicePointName ?? ''),
      distance: typeof s.distance === 'string' ? s.distance : undefined,
    };
  });
}

function parseJsonLdBlocks(html: string): JsonLdObject[] {
  return [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].flatMap(
    (match) => {
      const raw = match[1].trim();
      if (!raw) {
        return [];
      }

      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is JsonLdObject => typeof entry === 'object' && entry !== null);
      }
      return typeof parsed === 'object' && parsed !== null ? [parsed as JsonLdObject] : [];
    },
  );
}

function findProductJsonLd(blocks: JsonLdObject[]): JsonLdObject | undefined {
  return blocks.find((block) => getJsonLdType(block).includes('Product'));
}

function findCategory(blocks: JsonLdObject[]): string | undefined {
  const breadcrumb = blocks.find((block) => getJsonLdType(block).includes('BreadcrumbList'));
  const elements = Array.isArray(breadcrumb?.itemListElement) ? breadcrumb.itemListElement : [];
  const categories = elements
    .filter((entry): entry is JsonLdListItem => typeof entry === 'object' && entry !== null)
    .filter((entry) => {
      return typeof entry.position === 'number' && entry.position > 2 && getString(entry.name) !== undefined;
    })
    .map((entry) => getString(entry.name));

  return categories.at(0);
}

function getOffer(value: unknown): JsonLdOffer | undefined {
  if (Array.isArray(value)) {
    return value.find((entry): entry is JsonLdOffer => typeof entry === 'object' && entry !== null);
  }
  return typeof value === 'object' && value !== null ? (value as JsonLdOffer) : undefined;
}

function getBrand(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  if (typeof value === 'object' && value !== null) {
    return getString((value as JsonLdBrand).name);
  }
  return undefined;
}

function getImage(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return getString(value[0]);
  }
  return getString(value);
}

export function parseAldiProductSitemap(xml: string): AldiSitemapEntry[] {
  return [...xml.matchAll(/<url>\s*<loc>([\s\S]*?)<\/loc>(?:\s*<lastmod>([\s\S]*?)<\/lastmod>)?\s*<\/url>/gi)].map(
    (match) => ({
      loc: decodeXml(match[1].trim()),
      lastmod: match[2] ? decodeXml(match[2].trim()) : undefined,
    }),
  );
}

export function parseAldiProductPage(html: string, sourceUrl?: string): AldiParsedProduct | undefined {
  const blocks = parseJsonLdBlocks(html);
  const product = findProductJsonLd(blocks);
  if (!product) {
    throw new Error('Aldi product page did not contain Product JSON-LD.');
  }

  const name = getString(product.name);
  if (!name) {
    throw new Error('Aldi product JSON-LD is missing product name.');
  }

  const offer = getOffer(product.offers);
  const offerUrl = getString(offer?.url);
  const resolvedSourceUrl = sourceUrl ?? offerUrl;
  if (!resolvedSourceUrl) {
    throw new Error('Aldi product JSON-LD is missing source URL.');
  }

  const id = extractProductId(resolvedSourceUrl);
  if (!id) {
    throw new Error('Aldi product source URL is missing a product slug.');
  }

  const price = typeof offer?.price === 'number' ? offer.price : Number(getString(offer?.price));
  if (!Number.isFinite(price)) {
    return undefined;
  }

  const currency = getString(offer?.priceCurrency) ?? 'CHF';

  // Extract superscript markers (¹, ²) from HTML — indicate "special buy" / limited availability
  const tags: string[] = [];
  const superscriptMatch = html.match(/base-price__superscript[^>]*>(?:<!--.*?-->)?\s*([¹²])\s*<\/span>/);
  if (superscriptMatch) {
    tags.push(superscriptMatch[1] === '¹' ? 'special-buy' : 'limited-stock');
  }

  return {
    id,
    sourceUrl: resolvedSourceUrl,
    name,
    brand: getBrand(product.brand),
    price: {
      current: price,
      currency,
    },
    category: findCategory(blocks),
    image: getImage(product.image),
    availability: getString(offer?.availability),
    tags: tags.length > 0 ? tags : undefined,
  };
}
