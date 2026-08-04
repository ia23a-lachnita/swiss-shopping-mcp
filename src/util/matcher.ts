import { MatchMode, NormalizedProduct } from '../adapters/types.js';
import { normalize, tokenize } from './normalize.js';
import { CROSS_LANGUAGE_TERMS, modifierOf, vendorQueryFor } from './queryUnderstanding.js';

export { normalize } from './normalize.js';

export const TAXONOMY: Record<string, string[]> = {
  pasta: ['pasta', 'penne', 'spaghetti', 'fusilli', 'nudeln', 'maccheroni', 'tagliatelle', 'pappardelle'],
  bread: ['brot', 'bread', 'baguette', 'zopf', 'panini', 'semmel', 'gipfeli'],
  milk: ['milch', 'milk'],
  cheese: ['kase', 'cheese', 'gruyere', 'emmentaler', 'mozzarella', 'parmesan'],
  water: ['wasser', 'water', 'mineralwasser'],
  beer: ['bier', 'beer', 'lager', 'pils'],
  wine: ['wein', 'wine'],
  yogurt: ['joghurt', 'yogurt', 'yoghurt'],
  butter: ['butter', 'margarine'],
  eggs: ['eier', 'eggs', 'oeuf'],
  coffee: ['kaffee', 'coffee', 'espresso'],
  tea: ['tee', 'tea'],
  sugar: ['zucker', 'sugar'],
  salt: ['salz', 'salt'],
  oil: ['oel', 'oil', 'olivenoel'],
  meat: ['fleisch', 'meat', 'schweine', 'rind'],
  chicken: ['huhn', 'chicken', 'poulet'],
  fish: ['fisch', 'fish', 'lachs'],
  fruit: ['obst', 'fruit', 'apfel', 'banane', 'orange', 'orangen', 'zitrone', 'citrus', 'apfelsine', 'mandarine', 'grapefruit', 'limette'],
  apfel: ['apfel', 'apple', 'apfelsine', 'apfelschorle', 'apfelmus'],
  vegetables: ['gemuse', 'vegetables', 'karotten', 'tomaten'],
  cleaning: ['reinigung', 'cleaning', 'spulmittel'],
};

export function getAliases(query: string, dynamicTaxonomy?: Record<string, string[]>): string[] {
  const normalized = normalize(query);
  const taxonomy = dynamicTaxonomy ?? TAXONOMY;
  return taxonomy[normalized] ?? [normalized];
}

function getTokenAlternatives(token: string, matchMode: MatchMode, dynamicTaxonomy?: Record<string, string[]>): string[] {
  if (matchMode === 'literal') {
    return [token];
  }
  const taxonomy = dynamicTaxonomy ?? TAXONOMY;
  return Array.from(new Set([token, ...(taxonomy[token] ?? [])]));
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
  dynamicTaxonomy?: Record<string, string[]>,
): number | undefined {
  for (const alternative of getTokenAlternatives(token, matchMode, dynamicTaxonomy)) {
    if (alternative === token) continue;
    if (fieldIncludes(fields.name, alternative) || fieldIncludes(fields.brand, alternative)) return 40;
    if (fieldIncludes(fields.category, alternative) || fields.tags.some((tag) => fieldIncludes(tag, alternative))) {
      return 30;
    }
  }
  return undefined;
}

/**
 * A word starts somewhere in the field — as opposed to `includes`, which would
 * find "rot" inside "brot" and make bread a red thing.
 */
function fieldStartsWord(field: string, term: string): boolean {
  return field === term || field.startsWith(`${term} `) || field.includes(` ${term}`);
}

/**
 * Modifier match: the query carries an inflected form ("geriebener") and the
 * product carries the stem ("Käse gerieben"), or the other way round. Scored
 * below a direct hit so an exact spelling still wins the tie.
 */
function attributeTokenStrength(
  token: string,
  fields: ReturnType<typeof productFields>,
  matchMode: MatchMode,
): number | undefined {
  if (matchMode === 'literal') return undefined;
  const forms = modifierOf(token)?.forms;
  if (!forms) return undefined;

  for (const form of forms) {
    if (fieldStartsWord(fields.name, form) || fieldStartsWord(fields.brand, form)) return 70;
  }
  for (const form of forms) {
    if (
      fieldStartsWord(fields.category, form) ||
      fields.tags.some((tag) => fieldStartsWord(tag, form))
    ) {
      return 50;
    }
  }
  return undefined;
}

/**
 * Translation match: "lait" against a product called "Vollmilch".
 *
 * Ranked above the co-occurrence taxonomy (40) and below a direct hit (80),
 * because a curated translation is far stronger evidence than two words having
 * been seen in the same result set, and still weaker than the shopper's own
 * word appearing verbatim.
 */
function crossLanguageTokenStrength(
  token: string,
  fields: ReturnType<typeof productFields>,
  matchMode: MatchMode,
): number | undefined {
  if (matchMode === 'literal') return undefined;
  const equivalents = CROSS_LANGUAGE_TERMS[token];
  if (!equivalents) return undefined;

  for (const equivalent of equivalents) {
    if (fieldIncludes(fields.name, equivalent) || fieldIncludes(fields.brand, equivalent)) return 75;
  }
  for (const equivalent of equivalents) {
    if (
      fieldIncludes(fields.category, equivalent) ||
      fields.tags.some((tag) => fieldIncludes(tag, equivalent))
    ) {
      return 55;
    }
  }
  return undefined;
}

function tokenStrength(
  token: string,
  fields: ReturnType<typeof productFields>,
  matchMode: MatchMode,
  dynamicTaxonomy?: Record<string, string[]>,
): number | undefined {
  const direct =
    directTokenStrength(token, fields) ??
    crossLanguageTokenStrength(token, fields, matchMode) ??
    attributeTokenStrength(token, fields, matchMode);
  if (direct !== undefined) return direct;

  // A diet or allergen claim is never satisfied by association. The dynamic
  // taxonomy is built by co-occurrence, so one "Glutenfreies Brot" in the pool
  // teaches it that `glutenfreies` goes with `brot` — and then every bread
  // matches. Measured in the browser: "glutenfreies Brot" returned
  // Dinkel-Vollkornbrot and Butterzopf at strength 42 through exactly this
  // path, while the eval fixtures looked clean because the capture runs
  // without the local catalog that surfaced them.
  if (matchMode !== 'literal' && modifierOf(token)?.kind === 'constraint') return undefined;

  return taxonomyTokenStrength(token, fields, matchMode, dynamicTaxonomy);
}

/**
 * What one unmatched modifier costs.
 *
 * 20 puts a product that satisfies the noun but not the modifier (80 - 20 =
 * 60) below every product that satisfies both, and level with a category hit —
 * which is what it is: right kind of thing, unproven attribute.
 */
const MISSING_ATTRIBUTE_PENALTY = 20;

/**
 * What a satisfied modifier is worth.
 *
 * Small, because it only has to break ties the noun match cannot: grated
 * cheese often carries "Käse" in its category rather than its name (60), while
 * a cheese-flavoured crisp carries it in the name (80) and satisfies nothing
 * else (80 - 20 = 60). Without this the two are indistinguishable. Kept below
 * 10 so no combination of modifiers can lift a token match into the band
 * reserved for whole-query hits.
 */
const MATCHED_ATTRIBUTE_BONUS = 2;

export function calculateMatchStrength(
  product: NormalizedProduct,
  query: string,
  matchMode: MatchMode,
  dynamicTaxonomy?: Record<string, string[]>,
): number {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return 0;

  const fields = productFields(product);
  const direct = strengthForQuery(fields, normalizedQuery, matchMode, dynamicTaxonomy);

  // A romance query is dispatched to the vendors in German (see
  // `vendorQueryFor`), so the pool coming back is German — and scoring only
  // the shopper's original words would rank a body lotion called "Lait
  // Corporel" above Vollmilch for "lait entier", purely because it spells the
  // French word out. Both readings are scored and the better one wins.
  const vendorQuery = normalize(vendorQueryFor(normalizedQuery));
  if (matchMode === 'literal' || vendorQuery === normalizedQuery || !vendorQuery) return direct;

  return Math.max(direct, strengthForQuery(fields, vendorQuery, matchMode, dynamicTaxonomy));
}

function strengthForQuery(
  fields: ReturnType<typeof productFields>,
  normalizedQuery: string,
  matchMode: MatchMode,
  dynamicTaxonomy?: Record<string, string[]>,
): number {
  if (fields.name === normalizedQuery || fields.brand === normalizedQuery) return 100;
  if (fields.name.includes(normalizedQuery) || fields.brand.includes(normalizedQuery)) return 90;

  const tokens = tokenize(normalizedQuery);
  if (tokens.length === 0) return 0;

  // Nouns are mandatory, modifiers are preferences. A shopper asking for
  // "geriebener Käse" is better served by cheese than by nothing, but a
  // shopper asking for "Protein Milch" is not served by bread — and bread is
  // what a matcher that treats every token as optional returns, which is the
  // defect the golden set gates against.
  let weakest = Number.POSITIVE_INFINITY;
  let matched = 0;
  let matchedAttributes = 0;
  let missingAttributes = 0;

  for (const token of tokens) {
    const modifier = matchMode === 'literal' ? undefined : modifierOf(token);
    const strength = tokenStrength(token, fields, matchMode, dynamicTaxonomy);
    if (strength !== undefined) {
      weakest = Math.min(weakest, strength);
      matched += 1;
      if (modifier) matchedAttributes += 1;
      continue;
    }
    // A preference the product does not satisfy costs it rank. A constraint it
    // does not satisfy disqualifies it: nothing about "laktosefreie Milch" is
    // answered by milk that contains lactose.
    if (modifier?.kind === 'preference') {
      missingAttributes += 1;
      continue;
    }
    return 0;
  }

  // Every token was a modifier and none of them matched: nothing about this
  // product answers the query.
  if (matched === 0) return 0;

  return Math.max(
    1,
    weakest +
      matchedAttributes * MATCHED_ATTRIBUTE_BONUS -
      missingAttributes * MISSING_ATTRIBUTE_PENALTY,
  );
}

export function isExactProductMatch(
  product: NormalizedProduct,
  query: string,
  matchMode: MatchMode,
  dynamicTaxonomy?: Record<string, string[]>,
): boolean {
  return calculateMatchStrength(product, query, matchMode, dynamicTaxonomy) >= 80;
}

export function sortProducts(
  a: NormalizedProduct,
  b: NormalizedProduct,
  query?: string,
  matchMode: MatchMode = 'balanced',
  dynamicTaxonomy?: Record<string, string[]>,
): number {
  if (query) {
    const strengthA = calculateMatchStrength(a, query, matchMode, dynamicTaxonomy);
    const strengthB = calculateMatchStrength(b, query, matchMode, dynamicTaxonomy);

    if (strengthA !== strengthB) {
      return strengthB - strengthA; // Higher strength first
    }
  }

  if (a.price.current !== b.price.current) {
    return a.price.current - b.price.current;
  }
  return a.name.localeCompare(b.name);
}
