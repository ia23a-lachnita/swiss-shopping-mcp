/**
 * Food vs non-food, decided from the product's own name.
 *
 * The defect this exists for: a shopper asks for "Obst" and gets
 * `Dr. Beckmann Fleckenentferner Fleckenteufel Obst & Getränke` at rank 3 — a
 * stain remover, named after the stains it removes. Compound-head scoring
 * cannot touch it, because "Obst" is a standalone word there and not a
 * modifier, so every name-shape signal was already exhausted.
 *
 * It is not one product. Measured across the 51-query pool (4079 products),
 * these were passing the filter for food queries: two for "obst" (the stain
 * remover and a Dettol soap dispenser named "Gartenfrüchte"), five for
 * "lait entier" (Palmolive and Malizia liquid *soap* with milk, two oat-milk
 * shampoos), one for "beurre" (a shea *butter* shampoo). The pattern is a
 * whole class — non-food articles named after the food they act on or smell
 * like — and it collides with exactly the queries a category search produces.
 *
 * WHY NAME STEMS AND NOT THE VENDOR'S CATEGORY FIELD, which is the obvious
 * move and was this item's stated next lever: Migros populates `category` for
 * **zero** of its 1376 products in the pool, while Coop fills 1325, Ottos 848,
 * Aldi 351. Penalising a product because its category contradicts the query
 * therefore only ever punishes the chains that bothered to publish one —
 * antigravity called this a "metadata tax", and it is worse than it sounds: a
 * Coop stain remover would sink while an identically-named Migros one sailed
 * past, so the ranking would encode which vendor has better metadata rather
 * than which product answers the question. German product names, in contrast,
 * carry the function in the noun itself and do so in every chain — Migros
 * ships "Allzweckreiniger" and "Flüssig Waschmittel" under an empty category.
 * Name stems are the signal with 100% coverage.
 *
 * Departed from antigravity here: it proposed using the category as a
 * corroborating second trigger. Every one of the eight offenders measured above
 * is already caught by a name stem, so the category adds no coverage and
 * reintroduces the tax in weaker form. Left out until data asks for it.
 *
 * The vocabulary is deliberately small, closed, and used SYMMETRICALLY: the
 * same stems that mark a product non-food also mark a *query* non-food. That is
 * what keeps this from becoming the kind of open-ended denylist that caused the
 * "Milchdrink UHT" recall bug — "Zahnpasta", "Waschmittel" and
 * "Reinigungsmittel" are themselves golden queries, and the pool answers them
 * with 113, 109 and 53 correct non-food products which must not be demoted.
 * A rule that fires on the product alone would destroy all three.
 */

import { normalize, tokenize } from './normalize.js';
import { vendorQueryFor } from './queryUnderstanding.js';

/**
 * The rule fires only on a query we can positively identify as food.
 *
 * Learned the hard way, from the deterministic suite: "optimus" is a Swiss
 * *cleaning* brand, and a first version of this file classified it as a food
 * query merely because the word contains no cleaning stem — so every Optimus
 * WC-Reiniger was disqualified from its own brand search. Absence of evidence
 * for non-food is not evidence for food, and brands carry no domain in their
 * spelling at all.
 *
 * So the list below is POSITIVE, and that choice is what makes it safe: a term
 * missing from it means the rule declines to fire and the ranking is exactly
 * what it was before. An incomplete denylist silently deletes results (the
 * "Milchdrink UHT" bug); an incomplete allowlist silently declines to help.
 * Only the second is an acceptable way to be wrong.
 *
 * Every non-cleaning key of matcher's `HYPERNYMS` must appear here — asserted
 * by a test rather than by an import, because matcher.ts imports this module
 * and the reverse import would close a cycle.
 */
const FOOD_QUERY_TERMS = new Set([
  // Mirrors the food keys of HYPERNYMS.
  'teigwaren', 'pasta', 'nudeln', 'brot', 'reis', 'obst', 'fruchte', 'gemuse',
  'milch', 'kase', 'joghurt', 'eier', 'fleisch', 'fisch', 'wasser', 'bier',
  'wein', 'kaffee', 'tee',
  // Ordinary category words that are not hypernyms of anything, so they never
  // needed an entry there. `butter` earns its place directly: "beurre"
  // translates to it, and a shea-butter shampoo was reaching that top five.
  'butter', 'rahm', 'zucker', 'salz', 'mehl', 'honig', 'schokolade', 'frucht',
  'gemuese', 'fruit', 'ei', 'oel', 'konfiture',
]);

/** True when some token of the query — in either language — names food. */
export function queryIsKnownFood(query: string): boolean {
  const readings = [normalize(query), normalize(vendorQueryFor(normalize(query)))];
  return readings.some((reading) =>
    tokenize(reading).some((token) => FOOD_QUERY_TERMS.has(token)),
  );
}

/**
 * Stems that name what a non-food article *does*. Chosen for precision over
 * coverage: each is a functional noun with no food homograph in Swiss German
 * retail. Substring matching is intentional — German compounds them freely
 * (`Allzweckreiniger`, `Handgeschirrspülmittel`, `Seifenspender`).
 *
 * Deliberately NOT included, having been considered and rejected:
 * - `spray`, `tuch` — Backspray and Küchentuch are food-adjacent grocery items.
 * - `allzweck` — "Allzweckmehl" is flour; `reinig` already catches
 *   "Allzweckreiniger", which is the case that actually occurs.
 * - `fleck` — narrower `entferner` already catches the Dr. Beckmann product,
 *   and a bare `fleck` is a broader bet for no measured gain.
 */
export const NON_FOOD_STEMS: readonly string[] = [
  'reinig',
  'entferner',
  'entkalker',
  'waschmittel',
  'waschpulver',
  'weichspuler',
  'spulmittel',
  'klarspuler',
  'scheuermilch',
  'seife',
  'shampoo',
  'duschgel',
  'zahnpasta',
  'zahnburste',
  'deodorant',
  'desinfekt',
  'hygiene',
  'windel',
  'katzenstreu',
  // French, because Swiss catalogues mix languages within one chain.
  'nettoyant',
  'lessive',
];

/** The stem that marked this text non-food, or undefined. */
export function nonFoodStem(text: string): string | undefined {
  const folded = normalize(text);
  if (!folded) return undefined;
  return NON_FOOD_STEMS.find((stem) => folded.includes(stem));
}

/**
 * True when the shopper is asking *for* a non-food article. Such a query must
 * disable the rule entirely rather than invert it: "Reinigungsmittel" wants
 * cleaning products, and its pool is 53 of them.
 */
export function queryWantsNonFood(query: string): boolean {
  return nonFoodStem(query) !== undefined;
}

/**
 * True when this product answers a different macro-domain than the query asks
 * about — a stain remover for "Obst", a shampoo for "beurre".
 *
 * Only name and brand are read. Category is excluded on purpose; see the file
 * comment for why reading it would tax the chains that publish one.
 */
export function crossesFoodBoundary(
  query: string,
  // `brand` is nullable across the adapters, not merely absent.
  product: { name: string; brand?: string | null },
): boolean {
  if (!queryIsKnownFood(query)) return false;
  if (queryWantsNonFood(query)) return false;
  return nonFoodStem(`${product.name} ${product.brand ?? ''}`) !== undefined;
}
