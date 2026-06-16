import * as cheerio from 'cheerio';

export function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

export function stripHtml(value: string | undefined): string | undefined {
  const stripped = decodeHtml(
    (value ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
  return stripped || undefined;
}

export function parsePrice(value: string | undefined): number | undefined {
  const match = value?.replace(/'/g, '').match(/(\d+(?:[.,]\d{1,2})?)/);
  if (!match) {
    return undefined;
  }
  const parsed = Number(match[1].replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parsePercentage(value: string | undefined): number | undefined {
  const match = value?.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (!match) {
    return undefined;
  }
  const parsed = Number(match[1].replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseSwissDate(value: string): Date | undefined {
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

export function loadCheerio(html: string): cheerio.CheerioAPI {
  return cheerio.load(html);
}
