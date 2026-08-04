import { normalize } from './normalize.js';

/**
 * Query understanding: the two reasons a Swiss grocery query returns nothing.
 *
 * The relevance golden set (`src/eval/`) answers 46 of 51 queries with P@5
 * 0.991 — the ranker is not the problem. The 5 it cannot answer at all are
 * `geriebener Käse`, `glutenfreies Brot`, `rotes Thai Curry`, `lait entier`
 * and `jus d'orange`, and they fail for exactly two reasons:
 *
 * 1. **Inflected modifiers.** Matching is substring-based and conjunctive, so
 *    every query token must literally occur in the product. Retailers write
 *    "Käse gerieben"; a shopper writes "geriebener Käse". `gerieben` is not a
 *    substring of `geriebener`, so the whole product is discarded — not
 *    ranked lower, discarded.
 * 2. **Language.** Roughly 23% of Switzerland is francophone, and the catalogues
 *    the adapters query are German. `lait` never occurs in `Vollmilch`.
 *
 * Both are handled here rather than in `matcher.ts` so the vocabulary stays
 * inspectable in one place: these are lists a human has to be able to read and
 * correct, not logic.
 */

/**
 * Modifiers: words that *qualify* a product rather than name it, and what
 * happens when a product does not satisfy one.
 *
 * `preference` — a product that misses it is still an answer, ranked below the
 * ones that match. Plain cheese is a fair result for "geriebener Käse".
 *
 * `constraint` — a product that misses it is not an answer at all. Measured:
 * treating diet claims as preferences filled ranks 3-5 of "laktosefreie Milch"
 * with ordinary milk and coconut milk, and dropped that query's P@5 from 1.0
 * to 0.4. A shopper who cannot digest lactose is not weighing a trade-off, and
 * neither is one avoiding gluten. Both kinds still match across inflection —
 * that is what actually broke "glutenfreies Brot", not the strictness.
 *
 * Nouns are in neither list and are always mandatory: "Brot" must never be an
 * answer to "Protein Milch".
 *
 * Rows list interchangeable stems, needed where German spelling changes the
 * stem itself ("dunkel" but "dunkle", not "dunkele"). Everything is written in
 * `normalize()` form (`tiefkuhl`, not `Tiefkühl`) and a test asserts it — a
 * stem that does not survive normalisation would silently never match.
 */
interface ModifierEntry {
  forms: readonly string[];
  kind: 'preference' | 'constraint';
}

export const MODIFIERS: readonly ModifierEntry[] = [
  // Preparation and form
  { forms: ['gerieben'], kind: 'preference' },
  { forms: ['gehackt'], kind: 'preference' },
  { forms: ['geschnitten'], kind: 'preference' },
  { forms: ['gemahlen'], kind: 'preference' },
  { forms: ['gerauchert'], kind: 'preference' },
  { forms: ['getrocknet'], kind: 'preference' },
  { forms: ['gekocht'], kind: 'preference' },
  { forms: ['geschalt'], kind: 'preference' },
  { forms: ['geschlagen'], kind: 'preference' },
  { forms: ['paniert'], kind: 'preference' },
  { forms: ['passiert'], kind: 'preference' },
  { forms: ['gefullt'], kind: 'preference' },
  // Diet, allergen and certification claims — the ones a shopper cannot trade
  // away
  { forms: ['bio'], kind: 'constraint' },
  { forms: ['glutenfrei'], kind: 'constraint' },
  { forms: ['laktosefrei'], kind: 'constraint' },
  { forms: ['zuckerfrei'], kind: 'constraint' },
  { forms: ['alkoholfrei'], kind: 'constraint' },
  { forms: ['koffeinfrei'], kind: 'constraint' },
  { forms: ['vegan'], kind: 'constraint' },
  { forms: ['vegetarisch'], kind: 'constraint' },
  { forms: ['biologique', 'biologico'], kind: 'constraint' },
  // Process and storage
  { forms: ['fettarm'], kind: 'preference' },
  { forms: ['vollfett'], kind: 'preference' },
  { forms: ['frisch'], kind: 'preference' },
  { forms: ['tiefkuhl', 'tiefgekuhlt'], kind: 'preference' },
  { forms: ['gefroren'], kind: 'preference' },
  { forms: ['haltbar'], kind: 'preference' },
  { forms: ['pasteurisiert'], kind: 'preference' },
  { forms: ['gesalzen'], kind: 'preference' },
  { forms: ['ungesalzen'], kind: 'preference' },
  { forms: ['gesusst', 'ungesusst'], kind: 'preference' },
  // Colour, intensity, size
  { forms: ['rot'], kind: 'preference' },
  { forms: ['grun'], kind: 'preference' },
  { forms: ['gelb'], kind: 'preference' },
  { forms: ['weiss'], kind: 'preference' },
  { forms: ['schwarz'], kind: 'preference' },
  { forms: ['blau'], kind: 'preference' },
  { forms: ['braun'], kind: 'preference' },
  { forms: ['dunkel', 'dunkl'], kind: 'preference' },
  { forms: ['hell'], kind: 'preference' },
  { forms: ['gross'], kind: 'preference' },
  { forms: ['klein'], kind: 'preference' },
  { forms: ['mild'], kind: 'preference' },
  { forms: ['scharf'], kind: 'preference' },
  { forms: ['suss'], kind: 'preference' },
  { forms: ['salzig'], kind: 'preference' },
  // Provenance
  { forms: ['griechisch'], kind: 'preference' },
  { forms: ['italienisch'], kind: 'preference' },
  { forms: ['franzosisch'], kind: 'preference' },
  { forms: ['spanisch'], kind: 'preference' },
  { forms: ['thailandisch'], kind: 'preference' },
  { forms: ['schweizer'], kind: 'preference' },
  // French and Italian modifiers, so a romance query degrades the same way a
  // German one does
  { forms: ['entier', 'entiere'], kind: 'preference' },
  { forms: ['demi'], kind: 'preference' },
  { forms: ['ecreme'], kind: 'preference' },
  { forms: ['frais', 'fraiche'], kind: 'preference' },
  { forms: ['rape'], kind: 'preference' },
  { forms: ['hache'], kind: 'preference' },
  { forms: ['pele', 'pelati', 'pelato'], kind: 'preference' },
  { forms: ['intero'], kind: 'preference' },
  { forms: ['fresco'], kind: 'preference' },
  { forms: ['grattugiato'], kind: 'preference' },
  { forms: ['naturel', 'naturale'], kind: 'preference' },
  { forms: ['rouge', 'rosso'], kind: 'preference' },
  { forms: ['blanc', 'bianco'], kind: 'preference' },
  { forms: ['noir', 'nero'], kind: 'preference' },
  { forms: ['vert', 'verde'], kind: 'preference' },
];

/**
 * German (and romance) inflectional endings a modifier may carry.
 *
 * Deliberately an exhaustive list of *endings* rather than a stemmer: a
 * stemmer would also strip endings off nouns, and "Eier" → "Ei" would make
 * "Eis" a match for an egg query. Only the words in `MODIFIERS` are ever
 * stripped, and only by one of these endings, so the blast radius is the list
 * above and nothing else.
 */
const INFLECTIONS = ['', 'e', 'er', 'es', 'en', 'em', 's', 'ere', 'eren', 'este', 'esten', 'ste', 'sten'];

const MODIFIER_BY_INFLECTED_FORM = new Map<string, ModifierEntry>();
for (const entry of MODIFIERS) {
  for (const form of entry.forms) {
    for (const inflection of INFLECTIONS) {
      const inflected = `${form}${inflection}`;
      // First entry wins: a collision means two entries claim the same surface
      // form, which the MODIFIERS test rejects outright.
      if (!MODIFIER_BY_INFLECTED_FORM.has(inflected)) {
        MODIFIER_BY_INFLECTED_FORM.set(inflected, entry);
      }
    }
  }
}

/**
 * The modifier a token is an inflected form of, or undefined if it names
 * something.
 *
 * Matches the token against `stem + inflection` and never against a prefix, so
 * "Rotwein" is not read as the modifier "rot" (`rotwein` minus `rot` is
 * `wein`, which is not an ending) and stays a mandatory noun.
 */
export function modifierOf(token: string): ModifierEntry | undefined {
  return MODIFIER_BY_INFLECTED_FORM.get(token);
}

/**
 * Romance query terms and the German words that answer them.
 *
 * A translation table, not a synonym table: entries earn their place by being
 * unambiguous in a grocery context. `latte` is absent on purpose — it is milk
 * in Italian and half of "Emmi Caffè Latte" in Switzerland, and translating it
 * would turn a working brand query into a query for milk.
 *
 * Written in `normalize()` form on both sides.
 */
export const CROSS_LANGUAGE_TERMS: Readonly<Record<string, readonly string[]>> = {
  // French
  lait: ['milch'],
  beurre: ['butter'],
  fromage: ['kase'],
  oeuf: ['ei'],
  oeufs: ['eier'],
  pain: ['brot'],
  jus: ['saft'],
  eau: ['wasser'],
  vin: ['wein'],
  biere: ['bier'],
  cafe: ['kaffee'],
  the: ['tee'],
  sucre: ['zucker'],
  sel: ['salz'],
  farine: ['mehl'],
  huile: ['ol', 'oel'],
  riz: ['reis'],
  pates: ['teigwaren', 'pasta'],
  poisson: ['fisch'],
  viande: ['fleisch'],
  poulet: ['poulet', 'huhn'],
  pomme: ['apfel'],
  pommes: ['apfel'],
  legumes: ['gemuse'],
  yaourt: ['joghurt'],
  creme: ['rahm', 'creme'],
  chocolat: ['schokolade'],
  lessive: ['waschmittel'],
  dentifrice: ['zahnpasta'],
  // Italian
  burro: ['butter'],
  formaggio: ['kase'],
  uova: ['eier'],
  pane: ['brot'],
  succo: ['saft'],
  acqua: ['wasser'],
  vino: ['wein'],
  birra: ['bier'],
  caffe: ['kaffee'],
  zucchero: ['zucker'],
  sale: ['salz'],
  farina: ['mehl'],
  olio: ['ol', 'oel'],
  riso: ['reis'],
  pesce: ['fisch'],
  carne: ['fleisch'],
  pollo: ['poulet', 'huhn'],
  mela: ['apfel'],
  verdura: ['gemuse'],
  pomodori: ['tomaten'],
  pomodoro: ['tomaten'],
  cioccolato: ['schokolade'],
};

/**
 * Proper Swiss-German spelling for the few stems whose normalised form loses
 * an umlaut.
 *
 * The vocabulary above has to be normalised, because that is the form it is
 * compared against product text in. But a *dispatched* query goes to the
 * vendors' own search engines, which index real spelling — asking Coop for
 * "kase" is not the same as asking it for "Käse". Only entries that differ
 * need to appear here.
 */
const GERMAN_SPELLING: Readonly<Record<string, string>> = {
  kase: 'Käse',
  gemuse: 'Gemüse',
  ol: 'Öl',
  oel: 'Öl',
  grun: 'grün',
  suss: 'süss',
  gesusst: 'gesüsst',
  ungesusst: 'ungesüsst',
  geschalt: 'geschält',
  gerauchert: 'geräuchert',
  gefullt: 'gefüllt',
  franzosisch: 'französisch',
};

function forVendorSpelling(term: string): string {
  return GERMAN_SPELLING[term] ?? term;
}

/**
 * Words spelled the same in German and at least one romance language.
 *
 * They exist only so a query like "jus d'orange" still counts as fully
 * understood — `orange` is not evidence of *any* language, so treating it as
 * unknown would block the translation of `jus`.
 */
const LANGUAGE_NEUTRAL_TOKENS = new Set([
  'orange',
  'oranges',
  'tomate',
  'tomaten',
  'banane',
  'bananes',
  'ananas',
  'melone',
  'pizza',
  'risotto',
  'mozzarella',
  'salami',
  'joghurt',
  'yogurt',
  // Italian on the label but German on the shelf: Coop sells "Mutti Pelati
  // Pomodori" in the German-language catalogue, so dropping it as an
  // untranslatable modifier would throw away the most selective word in the
  // query. It stays a modifier for *matching* — plain tomatoes are still an
  // answer, just a worse one.
  'pelati',
  'cola',
  'bio',
  'baguette',
  'croissant',
  'menu',
  'dessert',
  'filet',
  'sauce',
  'salat',
]);

/**
 * The query to send to the vendors, which is not always the query the shopper
 * typed. Returns the input unchanged when neither rewrite below applies.
 *
 * Local matching cannot rank a product the adapters never fetched, so both of
 * the failures this module exists for have to be fixed *before* dispatch:
 *
 * **Translation.** The catalogues are German, so "lait entier" finds nothing
 * there however good the matcher is. All-or-nothing on purpose: a query is
 * only translated when *every* token is a known romance term, a modifier or
 * language-neutral, so one recognised word cannot hijack a query that is
 * mostly something else — "Emmi Caffè Latte" contains the Italian `caffe`, but
 * `emmi` is unknown, so the query goes out untouched and the brand resolves.
 *
 * **Canonical modifiers.** The vendors' own search is conjunctive too, and
 * their catalogues say "Käse gerieben". Measured against the live fan-out:
 * "geriebener Käse" returns one grated cheese among cheese-flavoured crisps,
 * "gerieben Käse" returns eight grated cheeses. Only the modifier is rewritten
 * and only when its normalised form differs, so the shopper's own nouns —
 * umlauts and all — are what the vendors actually receive.
 */
export function vendorQueryFor(query: string): string {
  const cached = rewriteCache.get(query);
  if (cached !== undefined) return cached;

  const translated = translateRomanceQuery(query);
  const rewritten = translated ?? canonicaliseModifiers(query);

  // Ranking calls this once per product per comparison, so the same handful of
  // strings is rewritten thousands of times per search. Bounded because the
  // keys are user input and this module outlives a request.
  if (rewriteCache.size >= REWRITE_CACHE_LIMIT) rewriteCache.clear();
  rewriteCache.set(query, rewritten);
  return rewritten;
}

const REWRITE_CACHE_LIMIT = 500;
const rewriteCache = new Map<string, string>();

function translateRomanceQuery(query: string): string | undefined {
  const normalized = normalize(query);
  if (!normalized) return undefined;

  const tokens = normalized.split(' ').filter((token) => token.length > 1);
  if (tokens.length === 0) return undefined;

  const translated: string[] = [];
  let didTranslate = false;

  for (const token of tokens) {
    const equivalents = CROSS_LANGUAGE_TERMS[token];
    if (equivalents) {
      translated.push(forVendorSpelling(equivalents[0]));
      didTranslate = true;
      continue;
    }
    if (LANGUAGE_NEUTRAL_TOKENS.has(token)) {
      translated.push(token);
      continue;
    }
    const modifier = modifierOf(token);
    if (modifier) {
      const german = CROSS_LANGUAGE_TERMS[modifier.forms[0]];
      // A modifier with no German equivalent ("entier") is dropped rather than
      // sent: one untranslated word is enough to make a conjunctive vendor
      // search answer with nothing.
      if (german) {
        translated.push(forVendorSpelling(german[0]));
        didTranslate = true;
      }
      continue;
    }
    // An unknown token means this is not a romance query we understand.
    return undefined;
  }

  if (!didTranslate || translated.length === 0) return undefined;
  return translated.join(' ');
}

function canonicaliseModifiers(query: string): string {
  const rawTokens = query.trim().split(/\s+/).filter(Boolean);
  if (rawTokens.length === 0) return query;

  let changed = false;
  const rewritten = rawTokens.map((rawToken) => {
    const token = normalize(rawToken);
    const modifier = modifierOf(token);
    if (!modifier || modifier.forms[0] === token) return rawToken;
    changed = true;
    return forVendorSpelling(modifier.forms[0]);
  });

  return changed ? rewritten.join(' ') : query;
}
