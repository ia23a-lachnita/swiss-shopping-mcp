/**
 * Labelled query corpus for search-relevance evaluation.
 *
 * Why patterns and not product IDs: vendor product IDs are per-chain and churn
 * whenever a catalogue is rewritten, so an ID-keyed label set rots within
 * weeks and silently stops asserting anything. Product *names* move far more
 * slowly, so relevance is judged by matching root lemmas against the folded
 * product name (see `foldForMatch`). This is an approximation — it can call a
 * product relevant that a human would not — which is exactly why the harness
 * gates on `forbidden` patterns (precise, unambiguous) and only *measures*
 * `relevant` patterns against a baseline.
 *
 * Labels are matched against the product's **identity** — name plus brand —
 * and never against category or ingredient/tag text. That line is the point of
 * the corpus: the defect it exists to catch is ingredient text being treated
 * as if it were the product's identity. Brand has to be included because
 * Migros and Aldi put the brand in `brand` and only the variant in `name`
 * ("Crunchy Almond", brand "Toblerone").
 */

/**
 * Linguistic archetype. Reported per bucket so a good score on easy category
 * queries cannot mask a collapse on compounds, which is where Swiss-German
 * retail search actually breaks.
 */
export type QueryBucket = 'compound' | 'multiword' | 'brand' | 'category' | 'romance';

/**
 * `gate` queries fail the build when a forbidden product reaches the top 5 —
 * reserved for defects we have actually observed in production, so the gate
 * always describes a real regression rather than a hypothetical one.
 * `measure` queries only contribute to the aggregate metrics.
 */
export type GoldenSeverity = 'gate' | 'measure';

export interface GoldenQuery {
  id: string;
  query: string;
  bucket: QueryBucket;
  /** Folded-name regexes; a matching product counts as relevant. */
  relevant: string[];
  /** Folded-name regexes; a matching product is wrong for this query. */
  forbidden: string[];
  severity: GoldenSeverity;
  /** Why this query is in the set — especially for `gate` entries. */
  note?: string;
}

/**
 * 50 queries. Sized to be maintainable by hand: a corpus nobody re-labels
 * after a catalogue change is worse than a smaller one that stays true.
 */
export const GOLDEN_QUERIES: GoldenQuery[] = [
  // ── Compounds: one word carrying the whole intent, the hardest class ──────
  {
    id: 'milchdrink-uht',
    query: 'Milchdrink UHT',
    bucket: 'compound',
    relevant: ['milchdrink', 'milch.*(drink|uht)', 'uht.*milch'],
    forbidden: ['schokolade', 'schoggi', 'brot', 'riegel', 'glace', 'kaffee'],
    severity: 'gate',
    note: 'Reported by the owner: returned Milchschokolade. Ingredient text ("Milch") ranked as if it were the product identity.',
  },
  {
    id: 'vollmilch',
    query: 'Vollmilch',
    bucket: 'compound',
    relevant: ['vollmilch', 'milch'],
    forbidden: ['schokolade', 'schoggi', 'riegel', 'brot'],
    severity: 'gate',
    note: 'Same failure mode as milchdrink-uht: "Vollmilch" is the classic chocolate ingredient string.',
  },
  { id: 'halbrahm', query: 'Halbrahm', bucket: 'compound', relevant: ['halbrahm', 'rahm'], forbidden: ['schokolade', 'glace', 'brot'], severity: 'measure' },
  { id: 'vollrahm', query: 'Vollrahm', bucket: 'compound', relevant: ['vollrahm', 'rahm'], forbidden: ['schokolade', 'glace'], severity: 'measure' },
  { id: 'magerquark', query: 'Magerquark', bucket: 'compound', relevant: ['magerquark', 'quark'], forbidden: ['joghurt.*frucht', 'schokolade'], severity: 'measure' },
  { id: 'ruebli', query: 'Rüebli', bucket: 'compound', relevant: ['rueebli', 'karotte', 'ruebli'], forbidden: ['kuchen', 'torte', 'saft'], severity: 'measure', note: 'Swiss-German for carrots; "Rüeblitorte" is the obvious false positive.' },
  { id: 'hackfleisch', query: 'Hackfleisch', bucket: 'compound', relevant: ['hackfleisch', 'hack', 'gehackt'], forbidden: ['vegan', 'vegi', 'planted'], severity: 'measure' },
  { id: 'apfelsaft', query: 'Apfelsaft', bucket: 'compound', relevant: ['apfelsaft', 'apfel.*saft'], forbidden: ['essig', 'mus', 'schorle.*trauben'], severity: 'measure' },
  { id: 'orangensaft', query: 'Orangensaft', bucket: 'compound', relevant: ['orangensaft', 'orange.*saft', 'jus.*orange'], forbidden: ['konfituere', 'marmelade', 'schokolade'], severity: 'measure' },
  { id: 'haferflocken', query: 'Haferflocken', bucket: 'compound', relevant: ['haferflocken', 'hafer'], forbidden: ['drink', 'milch', 'riegel'], severity: 'measure' },
  { id: 'sonnenblumenoel', query: 'Sonnenblumenöl', bucket: 'compound', relevant: ['sonnenblumenoel', 'sonnenblume.*oel'], forbidden: ['kerne', 'margarine', 'chips'], severity: 'measure' },
  { id: 'olivenoel', query: 'Olivenöl', bucket: 'compound', relevant: ['olivenoel', 'olive.*oel'], forbidden: ['oliven$', 'seife', 'tapenade'], severity: 'measure' },
  { id: 'kartoffeln', query: 'Kartoffeln', bucket: 'compound', relevant: ['kartoffel', 'patate'], forbidden: ['chips', 'stock', 'gratin.*fertig'], severity: 'measure' },
  { id: 'zwiebeln', query: 'Zwiebeln', bucket: 'compound', relevant: ['zwiebel'], forbidden: ['suppe', 'ring.*tiefkuehl', 'confit'], severity: 'measure' },
  { id: 'freilandeier', query: 'Freilandeier', bucket: 'compound', relevant: ['freiland.*ei', 'ei(er)?\\b'], forbidden: ['teigwaren', 'nudel', 'schokolade'], severity: 'measure' },
  { id: 'butter', query: 'Butter', bucket: 'compound', relevant: ['butter'], forbidden: ['erdnuss', 'peanut', 'keks', 'guetzli'], severity: 'measure', note: 'Erdnussbutter/peanut butter is the standard false positive.' },
  { id: 'mineralwasser', query: 'Mineralwasser', bucket: 'compound', relevant: ['mineralwasser', 'wasser', 'eau minerale'], forbidden: ['sirup', 'aroma', 'energy'], severity: 'measure' },
  { id: 'toilettenpapier', query: 'Toilettenpapier', bucket: 'compound', relevant: ['toilettenpapier', 'wc.*papier'], forbidden: ['kuechen.*rolle', 'taschentuch'], severity: 'measure' },
  { id: 'waschmittel', query: 'Waschmittel', bucket: 'compound', relevant: ['waschmittel', 'waschpulver', 'lessive'], forbidden: ['geschirr', 'spuel'], severity: 'measure' },
  { id: 'weissmehl', query: 'Weissmehl', bucket: 'compound', relevant: ['weissmehl', 'mehl'], forbidden: ['brot', 'mischung.*kuchen'], severity: 'measure' },
  { id: 'spaghetti', query: 'Spaghetti', bucket: 'compound', relevant: ['spaghetti'], forbidden: ['sauce', 'sugo', 'eis'], severity: 'measure' },
  { id: 'basmatireis', query: 'Basmatireis', bucket: 'compound', relevant: ['basmati', 'reis'], forbidden: ['waffel', 'drink', 'milch'], severity: 'measure' },
  { id: 'fruchtjoghurt', query: 'Fruchtjoghurt', bucket: 'compound', relevant: ['joghurt', 'yogurt'], forbidden: ['drink.*joghurt$', 'glace'], severity: 'measure' },
  { id: 'kaffeebohnen', query: 'Kaffeebohnen', bucket: 'compound', relevant: ['kaffee.*bohne', 'bohne.*kaffee', 'caffe.*grani'], forbidden: ['kapsel', 'pad', 'loeslich', 'instant'], severity: 'measure' },
  { id: 'zahnpasta', query: 'Zahnpasta', bucket: 'compound', relevant: ['zahnpasta', 'zahncreme', 'dentifrice'], forbidden: ['buerste', 'seide', 'spuelung'], severity: 'measure' },

  // ── Multi-word: attribute + head noun, where AND-matching goes wrong ──────
  {
    id: 'protein-milch',
    query: 'Protein Milch',
    bucket: 'multiword',
    relevant: ['protein.*milch', 'milch.*protein', 'protein.*drink'],
    forbidden: ['brot', 'brioche', 'riegel', 'pulver'],
    severity: 'gate',
    note: 'Reported by the owner: Aldi returned bread. Both tokens appear in bread ingredient text.',
  },
  { id: 'bio-vollmilch', query: 'Bio Vollmilch', bucket: 'multiword', relevant: ['bio.*milch', 'milch.*bio', 'vollmilch'], forbidden: ['schokolade', 'riegel'], severity: 'measure' },
  { id: 'laktosefreie-milch', query: 'laktosefreie Milch', bucket: 'multiword', relevant: ['laktosefrei', 'lactose.*free', 'sans lactose'], forbidden: ['schokolade', 'kaese'], severity: 'measure' },
  { id: 'griechischer-joghurt', query: 'griechischer Joghurt', bucket: 'multiword', relevant: ['griech.*joghurt', 'joghurt.*griech', 'greek'], forbidden: ['glace', 'drink'], severity: 'measure' },
  { id: 'geriebener-kaese', query: 'geriebener Käse', bucket: 'multiword', relevant: ['gerieben', 'raepe', 'kaese.*rieb'], forbidden: ['scheibe', 'stueck', 'fondue'], severity: 'measure' },
  { id: 'gehackte-tomaten', query: 'gehackte Tomaten', bucket: 'multiword', relevant: ['tomaten.*gehackt', 'gehackte.*tomaten', 'pelati', 'polpa'], forbidden: ['ketchup', 'suppe', 'frisch'], severity: 'measure' },
  { id: 'tiefkuehl-pizza', query: 'Tiefkühl Pizza', bucket: 'multiword', relevant: ['pizza'], forbidden: ['teig$', 'gewuerz', 'sauce'], severity: 'measure' },
  { id: 'glutenfreies-brot', query: 'glutenfreies Brot', bucket: 'multiword', relevant: ['glutenfrei.*brot', 'brot.*glutenfrei', 'sans gluten'], forbidden: ['mehl$', 'pasta'], severity: 'measure' },
  { id: 'dunkle-schokolade', query: 'dunkle Schokolade', bucket: 'multiword', relevant: ['schokolade', 'chocolat', 'noir', 'dark'], forbidden: ['milchdrink', 'getraenk', 'glace'], severity: 'measure', note: 'Mirror of milchdrink-uht: chocolate queries must NOT be dominated by milk drinks.' },
  { id: 'roter-thai-curry', query: 'rotes Thai Curry', bucket: 'multiword', relevant: ['curry', 'thai'], forbidden: ['wurst', 'chips'], severity: 'measure' },

  // ── Brand: exact-token queries that should be near-perfect ───────────────
  { id: 'aproz', query: 'Aproz', bucket: 'brand', relevant: ['aproz'], forbidden: [], severity: 'measure' },
  { id: 'zweifel-chips', query: 'Zweifel Chips', bucket: 'brand', relevant: ['zweifel'], forbidden: ['nuss$'], severity: 'measure' },
  { id: 'ovomaltine', query: 'Ovomaltine', bucket: 'brand', relevant: ['ovomaltine', 'ovo'], forbidden: [], severity: 'measure' },
  { id: 'rivella', query: 'Rivella', bucket: 'brand', relevant: ['rivella'], forbidden: [], severity: 'measure' },
  { id: 'emmi-caffe-latte', query: 'Emmi Caffè Latte', bucket: 'brand', relevant: ['emmi', 'caffe.*latte'], forbidden: ['bohne', 'kapsel'], severity: 'measure' },
  { id: 'coca-cola-zero', query: 'Coca Cola Zero', bucket: 'brand', relevant: ['coca.*cola', 'coca'], forbidden: ['pepsi'], severity: 'measure' },
  { id: 'toblerone', query: 'Toblerone', bucket: 'brand', relevant: ['toblerone'], forbidden: [], severity: 'measure' },
  { id: 'kaegi-fret', query: 'Kägi fret', bucket: 'brand', relevant: ['kaegi'], forbidden: [], severity: 'measure' },

  // ── Category: broad head nouns, recall-oriented ──────────────────────────
  { id: 'gemuese', query: 'Gemüse', bucket: 'category', relevant: ['gemuese', 'salat', 'karotte', 'rueebli', 'tomate', 'gurke', 'zwiebel', 'broccoli', 'legume'], forbidden: ['bouillon', 'chips'], severity: 'measure' },
  { id: 'obst', query: 'Obst', bucket: 'category', relevant: ['obst', 'apfel', 'banane', 'birne', 'orange', 'beere', 'traube', 'fruit'], forbidden: ['saft', 'konfituere', 'joghurt'], severity: 'measure' },
  { id: 'teigwaren', query: 'Teigwaren', bucket: 'category', relevant: ['teigwaren', 'pasta', 'spaghetti', 'penne', 'hoernli', 'fusilli', 'nudel'], forbidden: ['sauce', 'sugo'], severity: 'measure' },
  { id: 'reinigungsmittel', query: 'Reinigungsmittel', bucket: 'category', relevant: ['reiniger', 'reinigung', 'putz', 'nettoyant'], forbidden: ['hand.*creme', 'shampoo'], severity: 'measure' },

  // ── Romance-language labels: Switzerland is multilingual ────────────────
  { id: 'beurre', query: 'beurre', bucket: 'romance', relevant: ['beurre', 'butter'], forbidden: ['cacahuete', 'erdnuss'], severity: 'measure' },
  { id: 'lait-entier', query: 'lait entier', bucket: 'romance', relevant: ['lait', 'milch'], forbidden: ['chocolat', 'schokolade'], severity: 'measure' },
  { id: 'pomodori-pelati', query: 'pomodori pelati', bucket: 'romance', relevant: ['pelati', 'pomodor', 'tomaten'], forbidden: ['ketchup', 'sugo'], severity: 'measure' },
  { id: 'jus-orange', query: "jus d'orange", bucket: 'romance', relevant: ['jus.*orange', 'orangensaft', 'orange.*saft'], forbidden: ['confiture', 'konfituere'], severity: 'measure' },
];

export const GOLDEN_QUERIES_BY_ID = new Map(GOLDEN_QUERIES.map((q) => [q.id, q]));

/**
 * Queries captured a second time *with* web-search augmentation.
 *
 * A deliberate subset, not the whole corpus. Augmentation is rate-limited and
 * circuit-broken: the provider opens after 3 failures and stays open for five
 * minutes, and daily provider budgets are in the tens of requests. Capturing
 * all 51 queries therefore exhausts augmentation partway through and silently
 * writes vendor-only pools into the web tier — a fixture set that looks like
 * coverage and asserts nothing. Measured: a 51-query web capture produced
 * pools identical to the vendor tier for 49 of 51 queries.
 *
 * So the tier is scoped to where augmentation can actually do damage: it
 * injects web-discovered products at the *head* of the merged list, so the
 * risk is concentrated in the queries whose wrong answers we know about, plus
 * the ambiguous compounds most likely to attract an off-target web hit.
 */
export const WEB_TIER_QUERY_IDS = [
  'milchdrink-uht',
  'protein-milch',
  'vollmilch',
  'dunkle-schokolade',
  'butter',
  'ruebli',
  'haferflocken',
  'bio-vollmilch',
] as const;
