import * as cheerio from 'cheerio';
import { NormalizedPromotion, NormalizedPrice } from '../adapters/types.js';
import {
  decodeHtml,
  stripHtml,
  parsePrice,
  parsePercentage,
  parseSwissDate,
} from '../util/html.js';

function cleanContentSize(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/\bunit\./g, '').trim();
  return cleaned || undefined;
}

export interface DennerParsedPromotion {
  id: string;
  sourceUrl: string;
  title: string;
  productName: string;
  description?: string;
  image?: string;
  price: NormalizedPrice;
  originalPrice?: number;
  discount?: {
    type: 'percentage' | 'absolute';
    value: number;
  };
  validFrom: Date;
  validUntil: Date;
}

function normalizeUnit(unit: string): string {
  const normalized = unit.toLowerCase();
  if (normalized === 'liter' || normalized === 'litre') return 'l';
  if (normalized === 'cl') return 'cl';
  if (normalized === 'stück' || normalized === 'stuck') return 'piece';
  return normalized;
}

function parseUnit(description: string | undefined): NormalizedPrice['unit'] | undefined {
  if (!description) {
    return undefined;
  }

  const normalized = description.toLowerCase().replace(/,/g, '.');
  const factorMatch = normalized.match(
    /(\d+(?:\.\d+)?)\s*x\s*(?:(\d+(?:\.\d+)?)\s*x\s*)?(\d+(?:\.\d+)?)\s*(kg|g|l|liter|litre|ml|cl|stück|stuck)\b/
  );
  if (factorMatch) {
    const first = Number(factorMatch[1]);
    const second = factorMatch[2] ? Number(factorMatch[2]) : 1;
    const third = Number(factorMatch[3]);
    const unit = normalizeUnit(factorMatch[4]);
    if (Number.isFinite(first) && Number.isFinite(second) && Number.isFinite(third)) {
      return { value: first * second * third, per: unit };
    }
  }

  const singleMatch = normalized.match(
    /(\d+(?:\.\d+)?)\s*(kg|g|l|liter|litre|ml|cl|stück|stuck)\b/
  );
  if (singleMatch) {
    const value = Number(singleMatch[1]);
    if (Number.isFinite(value)) {
      return { value, per: normalizeUnit(singleMatch[2]) };
    }
  }

  return undefined;
}

function resolveUrl(sourceUrl: string, href: string): string {
  return new URL(decodeHtml(href), sourceUrl).toString();
}

function idFromUrl(sourceUrl: string): string | undefined {
  const url = new URL(sourceUrl);
  const slug = url.pathname.split('/').filter(Boolean).at(-1);
  const variant = url.searchParams.get('variant');
  return slug ? [slug, variant].filter(Boolean).join(':') : undefined;
}



export function parseDennerPromotionsPage(
  html: string,
  sourceUrl: string
): DennerParsedPromotion[] {
  const $ = cheerio.load(html);
  const promotions: DennerParsedPromotion[] = [];
  let currentValidUntil: Date | undefined;
  const dateRegex = /Bis\s+(\d{1,2}\.\d{1,2}\.\d{4})/gi;

  $('body').find('*').each((_index, element) => {
    const el = $(element);
    const text = el.text();

    let match;
    dateRegex.lastIndex = 0;
    while ((match = dateRegex.exec(text)) !== null) {
      const validUntil = parseSwissDate(match[1]);
      if (validUntil) {
        currentValidUntil = validUntil;
      }
    }

    if (el.hasClass('product-item')) {
      const card = el;

      const titleAnchor = card.find('.product-item__title');
      const href = titleAnchor.attr('href');
      const title = stripHtml(titleAnchor.text());
      const price = parsePrice(stripHtml(card.find('.price-tag__final-price').text()));
      if (!href || !title || price === undefined) {
        return;
      }

      const promotionSourceUrl = resolveUrl(sourceUrl, href);
      const id = idFromUrl(promotionSourceUrl);
      if (!id) {
        return;
      }

      const validUntil = currentValidUntil;
      if (!validUntil) {
        return;
      }

      const description = stripHtml(card.find('.product-item__subline').text());
      const originalPrice = parsePrice(stripHtml(card.find('.price-tag__instead').text()));
      const discountValue = parsePercentage(stripHtml(card.find('.price-tag__discount').text()));
      const image = card.find('img.product-item__image').attr('src');
      const decodedImage = image ? decodeHtml(image) : undefined;

      promotions.push({
        id,
        sourceUrl: promotionSourceUrl,
        title,
        productName: title,
        description,
        image: decodedImage,
        price: {
          current: price,
          unit: parseUnit(description),
        },
        originalPrice,
        discount:
          discountValue === undefined ? undefined : { type: 'percentage', value: discountValue },
        validFrom: new Date(0),
        validUntil,
      });
    }
  });

  if (promotions.length === 0) {
    throw new Error('Denner promotions page did not contain parseable product promotion cards.');
  }

  return promotions;
}

export function toNormalizedDennerPromotion(
  promotion: DennerParsedPromotion,
  provenance: NormalizedPromotion['provenance']
): NormalizedPromotion {
  return {
    id: promotion.id,
    chain: 'denner',
    title: promotion.title,
    productName: promotion.productName,
    description: promotion.description,
    image: promotion.image,
    price: promotion.price,
    originalPrice: promotion.originalPrice,
    discount: promotion.discount,
    validFrom: promotion.validFrom,
    validUntil: promotion.validUntil,
    provenance,
  };
}

export interface DennerParsedProduct {
  id: string;
  name: string;
  brand?: string;
  category?: string;
  price: NormalizedPrice;
  image?: string;
  productUrl?: string;
  size?: string;
}

export function parseDennerProductDetail(
  data: Record<string, unknown>,
  sourceUrl: string
): DennerParsedProduct | undefined {
  const remoteId = String(data.remoteId ?? data.id ?? '');
  const title = String(data.title ?? '');
  if (!remoteId || !title) {
    return undefined;
  }

  const sales = data.sales as Record<string, unknown> | undefined;
  const salesPrice = sales?.price as Record<string, unknown> | undefined;
  const priceRaw = typeof salesPrice?.raw === 'number' ? salesPrice.raw : undefined;
  if (priceRaw === undefined || priceRaw <= 0) {
    return undefined;
  }

  const tracking = data._tracking as Record<string, unknown> | undefined;
  const brand = typeof tracking?.item_brand === 'string' ? tracking.item_brand : undefined;

  const images = data.images as unknown[] | undefined;
  const firstImage = images?.[0] as Record<string, unknown> | undefined;
  const image = typeof firstImage?.cdnUrl === 'string' ? firstImage.cdnUrl : undefined;

  const categories = data.categories as unknown[] | undefined;
  const firstCategory = categories?.[0] as Record<string, unknown> | undefined;
  const categoryTitle = typeof firstCategory?.title === 'string' ? firstCategory.title : undefined;

  const description = typeof data.description === 'string' ? data.description : undefined;

  const jsonLd = data.jsonLd as Record<string, unknown> | undefined;
  const offers = jsonLd?.offers as Record<string, unknown> | undefined;
  const productUrl = typeof offers?.url === 'string' ? offers.url : sourceUrl;

  return {
    id: `denner:${remoteId}`,
    name: title,
    brand,
    category: categoryTitle,
    price: { current: priceRaw },
    image,
    productUrl,
    size: description,
  };
}

export function parseDennerSearchPage(
  html: string,
  sourceUrl: string
): DennerParsedProduct[] {
  const $ = cheerio.load(html);
  const products: DennerParsedProduct[] = [];

  $('body').find('*').each((_index, element) => {
    const el = $(element);

    if (el.hasClass('product-item')) {
      const card = el;

      const titleAnchor = card.find('.product-item__title');
      const href = titleAnchor.attr('href');
      const title = stripHtml(titleAnchor.text());
      const price = parsePrice(stripHtml(card.find('.price-tag__final-price').text()));
      if (!href || !title || price === undefined) {
        return;
      }

      const resolvedUrl = resolveUrl(sourceUrl, href);
      const id = idFromUrl(resolvedUrl);
      if (!id) {
        return;
      }

      const description = stripHtml(card.find('.product-item__subline').text());
      const image = card.find('img.product-item__image').attr('src');
      const decodedImage = image ? decodeHtml(image) : undefined;

      products.push({
        id,
        name: title,
        price: {
          current: price,
          unit: parseUnit(description),
        },
        image: decodedImage,
        productUrl: resolvedUrl,
        size: description,
      });
    }
  });

  return products;
}

interface PrediggoAttr {
  attributeName: string;
  vals?: Array<{ value: string; label?: string }>;
}

interface PrediggoSlot {
  item?: {
    sku?: string;
    price?: number;
    attributeInfo?: PrediggoAttr[];
  };
}

interface PrediggoSearchResponse {
  status?: string;
  blocks?: {
    searches?: Array<{
      slots?: PrediggoSlot[];
      stats?: { totalResults?: number; query?: string };
    }>;
  };
}

function extractPrediggoAttr(attrs: PrediggoAttr[], name: string): string | undefined {
  const attr = attrs.find((a) => a.attributeName === name);
  return attr?.vals?.[0]?.value;
}

export function parseDennerSearchApiResponse(
  data: unknown
): DennerParsedProduct[] {
  const response = data as PrediggoSearchResponse;
  if (response?.status !== 'OK') return [];

  const searches = response.blocks?.searches;
  if (!searches?.length) return [];

  const products: DennerParsedProduct[] = [];
  for (const block of searches) {
    const slots = block.slots ?? [];
    for (const slot of slots) {
      const item = slot.item;
      if (!item?.attributeInfo) continue;

      const attrs = item.attributeInfo;
      const name = extractPrediggoAttr(attrs, 'name');
      const trackingId = extractPrediggoAttr(attrs, '_tracking_item_id');
      const price = item.price;
      if (!name || !trackingId || typeof price !== 'number' || price <= 0) continue;

      const imageUrl = extractPrediggoAttr(attrs, 'imageUrl');
      const itemUrl = extractPrediggoAttr(attrs, 'itemUrl');
      const size = cleanContentSize(extractPrediggoAttr(attrs, 'content_size_text'));
      const categoryLabel = extractPrediggoAttr(attrs, 'category');

      const productUrl = itemUrl
        ? `https://www.denner.ch${itemUrl}`
        : `https://www.denner.ch/de/produkte/${trackingId}`;

      products.push({
        id: `denner:${trackingId}`,
        name,
        category: categoryLabel,
        price: { current: price },
        image: imageUrl,
        productUrl,
        size,
      });
    }
  }

  return products;
}

export function parseDennerCategoryPage(
  data: unknown,
  _sourceUrl: string
): DennerParsedProduct[] {
  if (!data || typeof data !== 'object') {
    return [];
  }

  const result = data as Record<string, unknown>;
  const items = result.items as unknown[] | undefined;
  if (!Array.isArray(items)) {
    return [];
  }

  const products: DennerParsedProduct[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const product = item as Record<string, unknown>;

    const remoteId = String(product.remoteId ?? product.id ?? '');
    const title = String(product.title ?? '');
    if (!remoteId || !title) continue;

    const sales = product.sales as Record<string, unknown> | undefined;
    const salesPrice = sales?.price as Record<string, unknown> | undefined;
    const priceRaw = typeof salesPrice?.raw === 'number' ? salesPrice.raw : undefined;
    if (priceRaw === undefined || priceRaw <= 0) continue;

    const tracking = product._tracking as Record<string, unknown> | undefined;
    const brand = typeof tracking?.item_brand === 'string' ? tracking.item_brand : undefined;

    const images = product.images as unknown[] | undefined;
    const firstImage = images?.[0] as Record<string, unknown> | undefined;
    const image = typeof firstImage?.cdnUrl === 'string' ? firstImage.cdnUrl : undefined;

    const categories = product.categories as unknown[] | undefined;
    const firstCategory = categories?.[0] as Record<string, unknown> | undefined;
    const categoryTitle = typeof firstCategory?.title === 'string' ? firstCategory.title : undefined;

    const description = typeof product.description === 'string' ? product.description : undefined;

    const productUrl = `https://www.denner.ch/de/produkte/${remoteId}`;

    products.push({
      id: `denner:${remoteId}`,
      name: title,
      brand,
      category: categoryTitle,
      price: { current: priceRaw },
      image,
      productUrl,
      size: description,
    });
  }

  return products;
}
