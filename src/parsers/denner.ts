import { NormalizedPromotion, NormalizedPrice } from '../adapters/types.js';

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

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function stripHtml(value: string | undefined): string | undefined {
  const stripped = decodeHtml(
    (value ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
  return stripped || undefined;
}

function parsePrice(value: string | undefined): number | undefined {
  const match = value?.replace(/'/g, '').match(/(\d+(?:[.,]\d{1,2})?)/);
  if (!match) {
    return undefined;
  }

  const parsed = Number(match[1].replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parsePercentage(value: string | undefined): number | undefined {
  const match = value?.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (!match) {
    return undefined;
  }

  const parsed = Number(match[1].replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseSwissDate(value: string): Date | undefined {
  const match = value.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!match) {
    return undefined;
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) {
    return undefined;
  }

  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
}

function normalizeUnit(unit: string): string {
  const normalized = unit.toLowerCase();
  if (normalized === 'liter' || normalized === 'litre') return 'l';
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

interface ValidityOffset {
  position: number;
  validUntil: Date;
}

function findValidityOffsets(html: string): ValidityOffset[] {
  return [...html.matchAll(/Bis\s+(\d{1,2}\.\d{1,2}\.\d{4})/gi)].flatMap((match) => {
    const validUntil = parseSwissDate(match[1]);
    if (!validUntil || match.index === undefined) {
      return [];
    }

    return [{ position: match.index, validUntil }];
  });
}

function findPreviousValidity(
  validityOffsets: ValidityOffset[],
  position: number
): Date | undefined {
  let previous: Date | undefined;
  for (const offset of validityOffsets) {
    if (offset.position > position) {
      break;
    }
    previous = offset.validUntil;
  }
  return previous;
}

function extractCardField(card: string, className: string): string | undefined {
  const pattern = new RegExp(
    `class=["'][^"']*${className}[^"']*["'][^>]*>([\\s\\S]*?)<\\/(?:div|a|span|p|h\\d)\\s*>`,
    'i'
  );
  return stripHtml(card.match(pattern)?.[1]);
}

function extractImage(card: string): string | undefined {
  const imageTag = card.match(/<img[^>]+class=["'][^"']*product-item__image[^"']*["'][^>]*>/i)?.[0];
  const source = imageTag?.match(/\ssrc=["']([^"']+)["']/i)?.[1];
  return source ? decodeHtml(source) : undefined;
}

export function parseDennerPromotionsPage(
  html: string,
  sourceUrl: string
): DennerParsedPromotion[] {
  const cardStarts = [...html.matchAll(/<div class=["']product-item stretch-link/gi)].map(
    (match) => match.index ?? 0
  );
  const validityOffsets = findValidityOffsets(html);
  const promotions: DennerParsedPromotion[] = [];

  for (let index = 0; index < cardStarts.length; index += 1) {
    const start = cardStarts[index];
    const end = cardStarts[index + 1] ?? html.length;
    const card = html.slice(start, end);

    const href = card.match(/href=["']([^"']+)["']/i)?.[1];
    const title = extractCardField(card, 'product-item__title');
    const price = parsePrice(extractCardField(card, 'price-tag__final-price'));
    const validUntil = findPreviousValidity(validityOffsets, start);
    if (!href || !title || price === undefined || !validUntil) {
      continue;
    }

    const promotionSourceUrl = resolveUrl(sourceUrl, href);
    const id = idFromUrl(promotionSourceUrl);
    if (!id) {
      continue;
    }

    const description = extractCardField(card, 'product-item__subline');
    const originalPrice = parsePrice(extractCardField(card, 'price-tag__instead'));
    const discountValue = parsePercentage(extractCardField(card, 'price-tag__discount'));

    promotions.push({
      id,
      sourceUrl: promotionSourceUrl,
      title,
      productName: title,
      description,
      image: extractImage(card),
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
