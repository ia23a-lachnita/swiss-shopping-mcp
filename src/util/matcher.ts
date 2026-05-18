import { MatchMode, NormalizedProduct } from '../adapters/types.js';

export const TAXONOMY: Record<string, string[]> = {
  pasta: ['pasta', 'penne', 'spaghetti', 'fusilli', 'nudeln', 'maccheroni', 'tagliatelle', 'pappardelle'],
  bread: ['brod', 'bread', 'baguette', 'zopf', 'panini', 'semmel', 'gipfeli'],
  milk: ['milch', 'milk'],
  cheese: ['kase', 'cheese', 'gruyere', 'emmentaler', 'mozzarella', 'parmesan'],
};

export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenize(value: string): string[] {
  const normalized = normalize(value);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

export function getAliases(query: string): string[] {
  const normalized = normalize(query);
  return TAXONOMY[normalized] ?? [normalized];
}

function getTokenAlternatives(token: string, matchMode: MatchMode): string[] {
  if (matchMode === 'literal') {
    return [token];
  }
  return Array.from(new Set([token, ...(TAXONOMY[token] ?? [])]));
}

function productFields(product: NormalizedProduct): {
  name: string;
  brand: string;
  category: string;
  tags: string[];
  all: string;
} {
  const name = normalize(product.name);
  const brand = normalize(product.brand ?? '');
  const category = normalize(product.category ?? '');
  const tags = (product.tags ?? []).map((tag) => normalize(tag));
  return {
    name,
    brand,
    category,
    tags,
    all: [name, brand, category, ...tags].filter(Boolean).join(' '),
  };
}

function fieldIncludes(field: string, term: string): boolean {
  return field.includes(term);
}

function directTokenStrength(token: string, fields: ReturnType<typeof productFields>): number | undefined {
  if (fieldIncludes(fields.name, token) || fieldIncludes(fields.brand, token)) return 80;
  if (fieldIncludes(fields.category, token) || fields.tags.some((tag) => fieldIncludes(tag, token))) return 60;
  return undefined;
}

function taxonomyTokenStrength(
  token: string,
  fields: ReturnType<typeof productFields>,
  matchMode: MatchMode,
): number | undefined {
  for (const alternative of getTokenAlternatives(token, matchMode)) {
    if (alternative === token) continue;
    if (fieldIncludes(fields.name, alternative) || fieldIncludes(fields.brand, alternative)) return 40;
    if (fieldIncludes(fields.category, alternative) || fields.tags.some((tag) => fieldIncludes(tag, alternative))) {
      return 30;
    }
  }
  return undefined;
}

function tokenStrength(token: string, fields: ReturnType<typeof productFields>, matchMode: MatchMode): number | undefined {
  return directTokenStrength(token, fields) ?? taxonomyTokenStrength(token, fields, matchMode);
}

export function calculateMatchStrength(product: NormalizedProduct, query: string, matchMode: MatchMode): number {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return 0;

  const fields = productFields(product);
  if (fields.name === normalizedQuery || fields.brand === normalizedQuery) return 100;
  if (fields.name.includes(normalizedQuery) || fields.brand.includes(normalizedQuery)) return 90;

  const strengths = tokenize(normalizedQuery).map((token) => tokenStrength(token, fields, matchMode));
  if (strengths.length === 0 || strengths.some((strength) => strength === undefined)) return 0;
  return Math.min(...(strengths as number[]));
}

export function isExactProductMatch(product: NormalizedProduct, query: string, matchMode: MatchMode): boolean {
  return calculateMatchStrength(product, query, matchMode) >= 80;
}

export function sortProducts(a: NormalizedProduct, b: NormalizedProduct, query?: string, matchMode: MatchMode = 'balanced'): number {
  if (query) {
    const strengthA = calculateMatchStrength(a, query, matchMode);
    const strengthB = calculateMatchStrength(b, query, matchMode);

    if (strengthA !== strengthB) {
      return strengthB - strengthA; // Higher strength first
    }
  }

  if (a.price.current !== b.price.current) {
    return a.price.current - b.price.current;
  }
  return a.name.localeCompare(b.name);
}
