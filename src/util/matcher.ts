import { MatchMode, NormalizedProduct } from '../adapters/types.js';
import { normalize, tokenize } from './normalize.js';
import { CROSS_LANGUAGE_TERMS, modifierOf, vendorQueryFor } from './queryUnderstanding.js';
import { crossesFoodBoundary } from './productDomain.js';

export { normalize } from './normalize.js';

/**
 * Category words, and the products that answer them.
 *
 * **Keyed by what a shopper types.** The previous table was keyed by English
 * concept names (`fruit -> ['obst', 'apfel', …]`) and looked up as
 * `TAXONOMY[queryToken]`, so a shopper typing `Obst` or `Teigwaren` got no
 * expansion at all — the words were values, never keys, and `teigwaren` was not
 * in the table in any position. Since an unrecognised token is mandatory (see
 * `strengthForQuery`), that did not merely fail to help: it disqualified every
 * product that did not spell the category word out. Measured live against the
 * vendor pools on 2026-08-05, "Teigwaren" kept 10 of 87 relevant products —
 * every Migros Hörnli, Penne and Spaghetti was discarded — and
 * "Reinigungsmittel" kept none of 32.
 *
 * **Directional on purpose.** Keys are hypernyms and values are their members;
 * a member never expands to its siblings. Symmetric expansion would make
 * "Apfel" match a banana at strength 40, which is the precision defect this
 * table would otherwise trade the recall defect for.
 *
 * Written in `normalize()` form (`hornli`, not `Hörnli`) and asserted by a
 * test — an entry that does not survive normalisation would silently never
 * match, which is how the modifier table lost `uht` for a month.
 */
export const HYPERNYMS: Record<string, string[]> = {
  // Prepared staples
  teigwaren: ['pasta', 'nudeln', 'spaghetti', 'spaghettini', 'penne', 'fusilli', 'hornli', 'maccheroni', 'magronen', 'tagliatelle', 'pappardelle', 'rigatoni', 'farfalle', 'orecchiette', 'lasagne', 'spiralen', 'spatzli', 'trivelli', 'cornettes'],
  pasta: ['teigwaren', 'nudeln', 'spaghetti', 'penne', 'fusilli', 'hornli', 'maccheroni', 'tagliatelle', 'pappardelle', 'rigatoni', 'farfalle', 'orecchiette', 'lasagne'],
  nudeln: ['teigwaren', 'pasta', 'spaghetti', 'penne', 'fusilli', 'hornli', 'tagliatelle'],
  brot: ['baguette', 'zopf', 'panini', 'semmel', 'gipfeli', 'ruchbrot', 'knackebrot'],
  reis: ['basmati', 'risotto', 'jasmin', 'langkorn', 'parboiled'],
  // Fresh produce
  obst: ['frucht', 'fruchte', 'apfel', 'apfeln', 'banane', 'bananen', 'birne', 'birnen', 'orange', 'orangen', 'mandarine', 'clementine', 'zitrone', 'limette', 'grapefruit', 'traube', 'trauben', 'beere', 'beeren', 'erdbeere', 'himbeere', 'heidelbeere', 'kirsche', 'kirschen', 'pfirsich', 'nektarine', 'aprikose', 'pflaume', 'zwetschge', 'feige', 'feigen', 'dattel', 'datteln', 'granatapfel', 'ananas', 'mango', 'kiwi', 'melone', 'physalis', 'passionsfrucht', 'kokosnuss', 'pitahaya', 'sultaninen', 'sultanine', 'rosinen', 'rosine', 'dorrobst', 'trockenfruchte'],
  fruchte: ['obst', 'apfel', 'banane', 'birne', 'orange', 'traube', 'beere', 'erdbeere', 'himbeere', 'kirsche', 'pfirsich', 'nektarine', 'aprikose', 'feige', 'dattel', 'ananas', 'mango', 'kiwi', 'melone'],
  gemuse: ['karotte', 'karotten', 'ruebli', 'rueebli', 'tomate', 'tomaten', 'gurke', 'zwiebel', 'zwiebeln', 'broccoli', 'brokkoli', 'blumenkohl', 'salat', 'lauch', 'sellerie', 'kohl', 'zucchetti', 'zucchini', 'peperoni', 'spinat', 'bohnen', 'erbsen', 'fenchel', 'rande', 'radieschen', 'aubergine'],
  // Dairy and protein
  milch: ['vollmilch', 'halbfett', 'milchdrink', 'rahm'],
  kase: ['gruyere', 'emmentaler', 'mozzarella', 'parmesan', 'raclette', 'appenzeller', 'tilsiter', 'brie', 'camembert'],
  joghurt: ['yogurt', 'yoghurt', 'jogurt'],
  eier: ['ei', 'freiland', 'bodenhaltung', 'oeuf'],
  fleisch: ['schweine', 'rind', 'kalb', 'lamm', 'poulet', 'huhn', 'hack'],
  fisch: ['lachs', 'thon', 'forelle', 'egli', 'crevetten'],
  // Drinks
  wasser: ['mineralwasser', 'quellwasser', 'eau'],
  bier: ['lager', 'pils', 'weizen', 'ale'],
  wein: ['rotwein', 'weisswein', 'rose'],
  kaffee: ['espresso', 'bohnen', 'caffe', 'lungo'],
  tee: ['the', 'tea'],
  // Household — the query word and the shelf word are almost never the same
  reinigungsmittel: ['reiniger', 'reinigung', 'putzmittel', 'putz', 'allzweckreiniger', 'badreiniger', 'glasreiniger', 'wc', 'scheuermilch', 'entkalker', 'nettoyant', 'spulmittel'],
  putzmittel: ['reiniger', 'reinigung', 'putz', 'allzweckreiniger', 'badreiniger', 'glasreiniger', 'scheuermilch', 'nettoyant'],
  waschmittel: ['waschpulver', 'lessive', 'flussigwaschmittel', 'colorwaschmittel'],
};

/**
 * Words for the *same thing*, as opposed to `HYPERNYMS`' broader-and-narrower.
 *
 * Kept in its own table because the two relations behave differently, which is
 * not a stylistic preference but the distinction every retrieval thesaurus
 * draws: ISO 25964-1 separates the **equivalence** relationship (USE/UF) from
 * the **hierarchical** one (BT/NT), WordNet separates a synset from the
 * hypernym links between synsets, and Lucene has a `SynonymQuery` distinct from
 * any taxonomy rewrite. Voorhees (1994) is the standard warning about what
 * happens when a query expander ignores the difference.
 *
 * **Symmetric, and safely so.** `HYPERNYMS` is directional to stop "Apfel"
 * matching a banana — correct, because those are *siblings*, and each is a
 * different fruit. `Rüebli` and `Karotte` are not siblings; they are the same
 * vegetable in Swiss German and standard German, so equivalence holds in both
 * directions by definition and expanding it cannot reach a different product.
 *
 * The cost of not having this was not a ranking wobble. An unrecognised token
 * is mandatory (see `strengthForQuery`), and `rueebli` appeared only as a
 * *value* under `gemuse`, never as a key — so it expanded to nothing and
 * disqualified every product that did not spell it out. Measured over the
 * frozen pools on 2026-08-06, the query "Rüebli" kept Rüebli *Keks*, a Rüebli
 * *Cake* and Betty Bossi *marzipan* carrots while discarding Migros `Karotten`,
 * `Snack Karotten`, `Baby Karotten` and `Erbsen und Karotten` — recall 0.150.
 * The filter was not weak on that query; it was inverted.
 *
 * **Deliberately not merged into `CROSS_LANGUAGE_TERMS`**, which is the obvious
 * home since a dialect word is a translation of a sort. That table also drives
 * `vendorQueryFor`, so an entry there rewrites the query *before dispatch* — and
 * Migros shelves its own products as "Rüebli", so translating it to "Karotte"
 * would lose the very products the entry exists to find. This table is read by
 * scoring only.
 *
 * Written in `normalize()` form and asserted by a test, like `HYPERNYMS`.
 */
export const SYNONYM_GROUPS: string[][] = [
  ['ruebli', 'karotte', 'karotten', 'ruben', 'mohre'],
  ['zucchetti', 'zucchini', 'courgette'],
  ['broccoli', 'brokkoli'],
  ['peperoni', 'paprika'],
  ['rande', 'randen'],
  ['aubergine', 'melanzani'],
  ['kartoffel', 'kartoffeln', 'herdopfel'],
  ['poulet', 'huhn', 'hahnchen'],
  ['rahm', 'sahne'],
  ['thon', 'thunfisch'],
  ['crevetten', 'garnelen'],
  ['konfiture', 'marmelade'],
  ['blumenkohl', 'karfiol'],
];

/**
 * Every member mapped to its whole group. Built once: the symmetry is derived
 * rather than hand-written, so a pair cannot be added in one direction only —
 * which is exactly how `rueebli`/`karotte` came to be missing.
 */
const SYNONYMS: Record<string, string[]> = Object.fromEntries(
  SYNONYM_GROUPS.flatMap((group) => group.map((term) => [term, group.filter((other) => other !== term)]))
);

/**
 * Scored at the *direct* bands (80 name/brand, 60 category) rather than the
 * taxonomy's 40/30.
 *
 * That is the Lucene `SynonymQuery` rule and it follows from what synonymy
 * means: if A and B name the same thing, a product called B answers a shopper
 * who typed A exactly as well as one called A. A hypernym member is discounted
 * because it only *partially* satisfies the intent — "Gemüse" asked for a
 * category and got one of its members — whereas nothing about `Karotten` is a
 * weaker answer to "Rüebli" than `Rüebli` is. The literal spelling still wins
 * ties through the whole-query bonuses of 100/90 above.
 */
function synonymTokenStrength(
  token: string,
  fields: ReturnType<typeof productFields>,
  matchMode: MatchMode,
): number | undefined {
  if (matchMode === 'literal') return undefined;
  const equivalents = SYNONYMS[token];
  if (!equivalents) return undefined;

  for (const equivalent of equivalents) {
    if (fieldHeadsWord(fields.name, equivalent) || fieldHeadsWord(fields.brand, equivalent)) return 80;
  }
  for (const equivalent of equivalents) {
    if (
      fieldHeadsWord(fields.category, equivalent) ||
      fields.tags.some((tag) => fieldHeadsWord(tag, equivalent))
    ) {
      return 60;
    }
  }
  return undefined;
}

/**
 * The curated table and the co-occurrence one, merged rather than swapped.
 *
 * `dynamicTaxonomy` used to *replace* this table wherever it was supplied,
 * which meant the curated categories silently stopped applying at the exact
 * point they were most useful — ranking the merged cross-vendor pool.
 */
function taxonomyFor(dynamicTaxonomy?: Record<string, string[]>): Record<string, string[]> {
  if (!dynamicTaxonomy) return HYPERNYMS;
  const merged: Record<string, string[]> = { ...dynamicTaxonomy };
  for (const [key, members] of Object.entries(HYPERNYMS)) {
    merged[key] = Array.from(new Set([...(merged[key] ?? []), ...members]));
  }
  return merged;
}

export function getAliases(query: string, dynamicTaxonomy?: Record<string, string[]>): string[] {
  const normalized = normalize(query);
  return taxonomyFor(dynamicTaxonomy)[normalized] ?? [normalized];
}

function getTokenAlternatives(token: string, matchMode: MatchMode, dynamicTaxonomy?: Record<string, string[]>): string[] {
  if (matchMode === 'literal') {
    return [token];
  }
  return Array.from(new Set([token, ...(taxonomyFor(dynamicTaxonomy)[token] ?? [])]));
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

/**
 * German inflectional endings, so the head rule below survives a plural:
 * "Karotten" answers `karotte`, "Äpfeln" answers `apfel`.
 */
const INFLECTION = '(?:e|en|er|n|s)?';

const HEAD_PATTERNS = new Map<string, RegExp>();

/**
 * Does the term *head* a word in this field, rather than merely occur inside
 * one?
 *
 * In a German compound the last stem says what the thing is and every earlier
 * stem only qualifies it: `Mischobst` is fruit, `Obstessig` is vinegar,
 * `Obstriegel` is a snack bar, `Rüeblitorte` is cake. Plain containment cannot
 * tell those apart, and it was ranking all four as equally good answers to
 * "Obst" — measured in the browser, the top four results for that query were
 * baby purée, vinegar, mixed fruit and a Dr. Beckmann stain remover.
 *
 * The eval's judge applies the same rule (`relevanceScoring.ts`), which costs
 * some of its independence as an instrument: a rule that is wrong about German
 * is now wrong in both places at once. Accepted deliberately — this is a fact
 * about the language rather than a copy of the matcher's logic, and the labels
 * the judge scores against stay human-written.
 */
function fieldHeadsWord(field: string, term: string): boolean {
  let pattern = HEAD_PATTERNS.get(term);
  if (!pattern) {
    pattern = new RegExp(`${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${INFLECTION}\\b`);
    HEAD_PATTERNS.set(term, pattern);
  }
  return pattern.test(field);
}

/**
 * What a match inside a compound is worth when it is not the head.
 *
 * Deliberately not zero: "Obstriegel" is a defensible thing to show someone who
 * searched for fruit, just not above actual fruit. Kept below the co-occurrence
 * taxonomy's 40 so a real Granatapfel — which can only reach 40 — outranks it.
 */
const COMPOUND_MODIFIER_STRENGTH = 20;

function directTokenStrength(token: string, fields: ReturnType<typeof productFields>): number | undefined {
  if (fieldHeadsWord(fields.name, token) || fieldHeadsWord(fields.brand, token)) return 80;
  if (fieldHeadsWord(fields.category, token) || fields.tags.some((tag) => fieldHeadsWord(tag, token))) {
    return 60;
  }
  if (
    fieldIncludes(fields.all, token) ||
    fields.tags.some((tag) => fieldIncludes(tag, token))
  ) {
    return COMPOUND_MODIFIER_STRENGTH;
  }
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
    // Head position here too, and for the same reason: without it the category
    // member `fruchte` matched "Früchtetee" and "Früchtequark" — a tea and a
    // quark — and ranked them among the answers to "Obst".
    if (fieldHeadsWord(fields.name, alternative) || fieldHeadsWord(fields.brand, alternative)) {
      return 40;
    }
    if (
      fieldHeadsWord(fields.category, alternative) ||
      fields.tags.some((tag) => fieldHeadsWord(tag, alternative))
    ) {
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

/**
 * Shortest half a German compound may be split into. Four keeps `frucht|joghurt`
 * and `kaffee|bohnen` while refusing the splits that would make any token match
 * something ("bio", "uht", and the `ei` hiding at the front of "Eier").
 */
const COMPOUND_MIN_PART = 4;

/**
 * Compound match: the shopper writes one word and the retailer writes two.
 *
 * German lets a noun phrase close up into a single word, and shoppers use that
 * freedom while catalogues do not: "Freilandeier" is shelved as "Eier,
 * Freiland", "Basmatireis" as "Basmati Reis", "Kaffeebohnen" as "Kaffee
 * Bohnen". The closed form is a substring of nothing, so an exact-token matcher
 * disqualifies every one of them — measured over the captured vendor pools,
 * this alone cost "Freilandeier" 35 of 42 relevant products and "Kaffeebohnen"
 * 77 of 89.
 *
 * **Both halves must hit the same product.** That makes a split match strictly
 * harder to earn than the whole token, not easier, which is what keeps this
 * from becoming the "any token matches something" defect in a new costume.
 * Scored below every direct path so an exact spelling still outranks it.
 */
function compoundTokenStrength(
  token: string,
  fields: ReturnType<typeof productFields>,
  matchMode: MatchMode,
): number | undefined {
  if (matchMode === 'literal' || token.length < COMPOUND_MIN_PART * 2) return undefined;

  for (let split = COMPOUND_MIN_PART; split <= token.length - COMPOUND_MIN_PART; split += 1) {
    const head = directTokenStrength(token.slice(0, split), fields);
    if (head === undefined) continue;
    const tail = directTokenStrength(token.slice(split), fields);
    if (tail === undefined) continue;
    // The weaker half decides: a compound proven only through a category hit is
    // no better established than that hit.
    return Math.min(head, tail) - COMPOUND_SPLIT_PENALTY;
  }
  return undefined;
}

/** Distance between "spelled exactly as asked" and "assembled from two hits". */
const COMPOUND_SPLIT_PENALTY = 20;

function tokenStrength(
  token: string,
  fields: ReturnType<typeof productFields>,
  matchMode: MatchMode,
  dynamicTaxonomy?: Record<string, string[]>,
): number | undefined {
  const direct =
    directTokenStrength(token, fields) ??
    synonymTokenStrength(token, fields, matchMode) ??
    crossLanguageTokenStrength(token, fields, matchMode) ??
    attributeTokenStrength(token, fields, matchMode) ??
    compoundTokenStrength(token, fields, matchMode);
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

  // A non-food article never answers a food query, however well its name
  // scores. `Fleckenentferner … Obst & Getränke` is a stain remover and
  // `Flüssigseife Milch+Honig` is soap; both were reaching the top 5. Checked
  // before scoring rather than as a penalty afterwards, because the score is
  // exactly what is wrong about them — the name really does contain the word.
  // Literal mode is exempt: it exists to take the shopper at their word.
  if (matchMode !== 'literal' && crossesFoodBoundary(normalizedQuery, product)) return 0;

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
  // Head-position, for the same reason as `directTokenStrength`: without it
  // "Obstessig" collects the whole-query bonus of 90 for the query "Obst" and
  // is out of reach of every real piece of fruit before token scoring even
  // starts.
  if (fieldHeadsWord(fields.name, normalizedQuery) || fieldHeadsWord(fields.brand, normalizedQuery)) {
    return 90;
  }

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
