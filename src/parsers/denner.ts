import * as cheerio from 'cheerio';
import { NormalizedPromotion, NormalizedPrice } from '../adapters/types.js';
import {
  decodeHtml,
  stripHtml,
  parsePrice,
  parsePercentage,
  parseSwissDate,
} from '../util/html.js';

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
