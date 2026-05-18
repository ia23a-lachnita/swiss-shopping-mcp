# swiss-shopping-mcp — Manual MCP Test Report

Date: 2026-05-17
Target: live `swiss-shopping-mcp` MCP server (static catalog adapters, all 8 chains)
Tools under test: `search_products`, `find_stores`, `compare_prices`,
`get_store_availability_support`, `lookup_store_product_availability`

## Method

Test cases are derived from the static catalog (`src/adapters/staticCatalog.ts`)
and the matching/sorting logic in `staticChainAdapter.ts`, `searchService.ts`,
and `priceComparisonService.ts`. Each case lists the call, the expected result
(reasoned from the code + data), the actual result from the live MCP call, and
a pass/fail status.

Matching rule under test: a product matches when the lowercased
`name + brand + category + tags` string contains **every** whitespace token of
the query. Products sort by `price.current` ascending, then name. Stores sort by
name. Availability is supported only for `migros`.

## Reference catalog (abridged)

| Chain | Product | Price CHF | Tags | Allergens |
|---|---|---|---|---|
| migros | Organic Whole Milk | 1.85 | organic, vegetarian | milk |
| migros | Wholegrain Pasta | 1.70 | vegan, vegetarian | gluten |
| coop | Bio Whole Milk | 1.95 | organic, vegetarian | milk |
| coop | Basmati Rice | 2.90 | vegan, gluten-free, vegetarian | — |
| aldi | Rolled Oats | 1.80 | vegan, vegetarian | gluten |
| aldi | Apples Gala | 2.20 | vegan, gluten-free, vegetarian | — |
| denner | Free Range Eggs | 3.95 | vegetarian | egg |
| denner | Penne Rigate | 1.20 | vegan, vegetarian | gluten |
| lidl | Greek Yogurt | 2.40 | vegetarian | milk |
| lidl | Chickpeas | 1.10 | vegan, gluten-free, vegetarian | — |
| farmy | Sourdough Bread | 4.90 | vegetarian, organic | gluten |
| farmy | Baby Spinach | 3.50 | vegan, gluten-free, organic, vegetarian | — |
| volg | Mountain Cheese | 3.70 | vegetarian | milk |
| volg | Swiss Potatoes | 2.80 | vegan, gluten-free, vegetarian | — |
| ottos | Laundry Detergent | 5.20 | budget | — |
| ottos | Spaghetti | 1.00 | vegan, vegetarian | gluten |

Stores (one per chain): migros-zurich-1 (Zürich, 8001), coop-basel-1 (Basel,
4051), aldi-bern-1 (Bern, 3011), denner-luzern-1 (Luzern, 6003), lidl-geneva-1
(Genève, 1205), farmy-zurich-warehouse (Zürich, 8005), volg-stgallen-1 (St.
Gallen, 9000), ottos-zug-1 (Zug, 6300). Migros store inventory:
`migros-zurich-1 → [migros-milk-1l]` only.

---

## search_products

| # | Input | Expected | Actual | Status |
|---|---|---|---|---|
| S1 | `query: "milk"` | Organic Whole Milk (migros, 1.85) then Bio Whole Milk (coop, 1.95) | Exactly as expected, price-sorted | PASS |
| S2 | `query: "pasta"` | Only migros Wholegrain Pasta (1.70). Denner Penne Rigate / Otto's Spaghetti do NOT match — documents token-substring limitation | Only Wholegrain Pasta returned; Penne/Spaghetti absent as predicted | PASS |
| S3 | `query: "rice", chains: ["coop"]` | Coop Basmati Rice (2.90) only | Basmati Rice (coop, 2.90) | PASS |
| S4 | `query: "milk", maxPrice: 1.90` | Only migros Organic Whole Milk (1.85); coop (1.95) filtered out | Only migros 1.85 | PASS |
| S5 | `query: "pasta", dietaryPreferences: ["vegan"]` | migros Wholegrain Pasta (has vegan tag) | Wholegrain Pasta returned | PASS |
| S6 | `query: "milk", excludeAllergens: ["milk"]` | Empty list, `ok:true` (both milks carry milk allergen) | `{"products":[]}` | PASS |
| S7 | `query: "milk", category: "dairy"` | Both milks (migros 1.85, coop 1.95) | Both milks, price order | PASS |
| S8 | `query: "produce"` | Apples Gala (aldi, 2.20), Swiss Potatoes (volg, 2.80), Baby Spinach (farmy, 3.50) — price order | Apples 2.20, Potatoes 2.80, Spinach 3.50 | PASS |
| S9 | `query: "vegetarian", limit: 2` | Two cheapest vegetarian-tagged: Spaghetti (ottos, 1.00), Chickpeas (lidl, 1.10) | Spaghetti 1.00, Chickpeas 1.10 | PASS |
| S10 | `query: "zzzznotfound"` | Empty list, `ok:true` | `{"products":[]}` | PASS |
| S11 | `query: " "` (whitespace → trims to empty) | Validation error (`INVALID_ARGUMENTS`) | `INVALID_ARGUMENTS: query: String must contain at least 1 character(s)` | PASS |
| S12 | `query: "whole milk"` | Multi-token: Organic Whole Milk (1.85), Bio Whole Milk (1.95) | Both, price order | PASS |

## find_stores

| # | Input | Expected | Actual | Status |
|---|---|---|---|---|
| F1 | `location: "Zürich"` | Farmy Zürich Hub then Migros Zürich HB (name sort) | Farmy Zürich Hub, Migros Zürich HB | PASS |
| F2 | `location: "8001"` | Migros Zürich HB only (ZIP in address) | Migros Zürich HB only | PASS |
| F3 | `location: "Basel"` | Coop Basel Central | Coop Basel Central | PASS |
| F4 | `location: "1205"` | Lidl Genève Plainpalais (ZIP in address) | Lidl Genève Plainpalais | PASS |
| F5 | `location: "Atlantis"` | Empty list, `ok:true` | `{"stores":[]}` | PASS |
| F6 | `location: "Zürich", chains: ["migros"]` | Migros Zürich HB only | Migros Zürich HB only | PASS |

## compare_prices

| # | Input | Expected | Actual | Status |
|---|---|---|---|---|
| C1 | `query: "milk"` | Cheapest migros 1.85, most expensive coop 1.95, savings 0.10, quantity 1 | cheapest migros 1.85, dearest coop 1.95, savings 0.1 | PASS |
| C2 | `query: "pasta", quantity: 3` | Single offer migros total 5.10, savings 0.00 | totalPrice 5.1, savings 0 | PASS |
| C3 | `query: "milk", quantity: 2` | migros total 3.70, coop total 3.90, savings 0.20 | migros 3.7, coop 3.9, savings 0.2 | PASS |
| C4 | `query: "doesnotexist"` | Empty offers, cheapest/mostExpensive/savings undefined | `offers:[]`, other fields omitted | PASS |
| C5 | `query: "produce"` | Apples (aldi 2.20), Potatoes (volg 2.80), Spinach (farmy 3.50), savings 1.30 | Apples 2.2, Potatoes 2.8, Spinach 3.5, savings 1.3 | PASS |

## get_store_availability_support

| # | Input | Expected | Actual | Status |
|---|---|---|---|---|
| A1 | (no args) | 8 entries sorted by chain; only migros `supported:true`, rest `false` w/ reason | aldi,coop,denner,farmy,lidl,migros(true),ottos,volg — exact | PASS |
| A2 | `chains: ["migros"]` | Single entry migros `supported:true` | `[{migros,true}]` | PASS |
| A3 | `chains: ["coop","migros"]` | coop `false` then migros `true` (chain sort) | coop false, migros true | PASS |

## lookup_store_product_availability

| # | Input | Expected | Actual | Status |
|---|---|---|---|---|
| L1 | `migros / migros-zurich-1 / "milk"` | supported true, Organic Whole Milk available:true, isAvailable true | Exactly as expected | PASS |
| L2 | `migros / migros-zurich-1 / "pasta"` | supported true, Wholegrain Pasta available:false, isAvailable false | available:false, isAvailable:false | PASS |
| L3 | `coop / coop-basel-1 / "milk"` | supported false, reason set, matches [], isAvailable false, `ok:true` | supported:false, reason set, empty matches | PASS |
| L4 | `migros / bogus-store / "milk"` | Error `STORE_NOT_FOUND` (isError) | `STORE_NOT_FOUND: Store not found for chain migros: bogus-store` | PASS |
| L5 | `migros / migros-zurich-1 / "cheese"` | supported true, matches [], isAvailable false | supported:true, matches:[], isAvailable:false | PASS |

---

## Results summary

| Tool | Cases | Pass | Fail |
|---|---|---|---|
| search_products | 12 | 12 | 0 |
| find_stores | 6 | 6 | 0 |
| compare_prices | 5 | 5 | 0 |
| get_store_availability_support | 3 | 3 | 0 |
| lookup_store_product_availability | 5 | 5 | 0 |
| **Total** | **31** | **31** | **0** |

All 31 cases passed: every live MCP response matched the result reasoned from
the catalog data and service logic. Input validation, multi-chain fan-out,
price/name sorting, filtering, the Migros-only availability gate, and error
paths (`INVALID_ARGUMENTS`, `STORE_NOT_FOUND`) all behave as designed.

## Findings & notes

These are behavioural observations, not test failures. They reflect design
choices worth tracking, not defects in the V1 static scope.

1. **Query matching is plain substring-over-tokens, not semantic** (S2).
   `query:"pasta"` returns only migros "Wholegrain Pasta". Denner "Penne
   Rigate" and Otto's "Spaghetti" are real pasta products but never match
   because neither their name/brand/category/tags contain the literal token
   `pasta`. Cross-chain comparison is therefore only as good as literal naming
   overlap — a known limitation of the static catalog matcher.

2. **`compare_prices` ranks by pack total price, not normalized unit price**
   (C5). Baby Spinach reports `unitPrice: 14` (CHF 3.50 ÷ 0.25 kg pack = 14/kg)
   yet is sorted as "most expensive" by `totalPrice` 3.50. `unitPrice` is
   computed (`price.current / unit.value`) but never used for ranking or
   `savingsVsMostExpensive`. Comparing differently-sized packs does not yet
   surface true best value-per-kg. Candidate for the promotion/value-aware
   comparison work in the tracker's "Next tasks".

3. **`compare_prices` keeps only the first product per chain** (C5). It takes
   `products.slice(0, 1)` per chain, so a chain's cheapest matching item wins
   its slot but alternative items in the same chain are discarded before
   ranking. Expected for V1; note for future multi-offer comparison.

4. **Empty-result vs error semantics are consistent.** No matches returns
   `ok:true` with an empty array/offer list (S6, S10, F5, C4); only invalid
   input (S11) or a missing store (L4) produce `isError`. Unsupported chains
   for availability return `ok:true, supported:false` with a reason (L3) rather
   than an error — correct graceful degradation.

5. **Whitespace-only query is rejected** (S11): `" "` trims to empty and fails
   Zod validation with `INVALID_ARGUMENTS`, confirming the trim+min(1) guard.

## Follow-up implementation

Date: 2026-05-17

The usability caveats above have been addressed in the codebase:

- Static catalog search now supports balanced matching by default, with a
  `matchMode: "literal"` escape hatch for the old strict token behavior.
- `pasta` now matches the pasta family across static chains, including
  `Wholegrain Pasta`, `Penne Rigate`, and `Spaghetti`.
- `compare_prices` now supports `comparisonBasis: "unitPrice"` in addition to
  backward-compatible `packPrice` ranking.
- `limitPerChain` defaults to one returned offer per chain, but values greater
  than one now return in-chain alternatives instead of discarding them.
- Unit-price comparison normalizes compatible units and marks missing or mixed
  unit dimensions as ineligible rather than silently ranking unlike units.
- Availability lookup uses the same balanced matcher while preventing broad
  alias matches from making `isAvailable` true when exact/name matches are
  present but unavailable.

## Post-implementation regression cases

Date: 2026-05-18

These cases verify the follow-up implementation against the live MCP tool
surface. They supplement the original 31-case baseline above, which remains as
the historical pre-fix manual pass.

| # | Tool | Input | Expected | Actual | Status |
|---|---|---|---|---|---|
| R1 | `search_products` | `query: "pasta", matchMode: "balanced", limit: 10` | Pasta family across chains: `migros-pasta-500g`, `ottos-pasta-500g`, `denner-pasta-500g` | Exactly those 3 products in match-strength order | PASS |
| R2 | `search_products` | `query: "pasta", matchMode: "literal", limit: 10` | Strict literal mode only matches `Wholegrain Pasta` | Only `migros-pasta-500g` returned | PASS |
| R3 | `search_products` | `query: "pasta", matchMode: "balanced", chains: ["ottos"]` | Taxonomy alias allows Otto's `Spaghetti` to match `pasta` | `ottos-pasta-500g` returned | PASS |
| R4 | `compare_prices` | `query: "pasta", comparisonBasis: "unitPrice"` | Rank by CHF/kg: Otto's 2.00/kg, Denner 2.40/kg, Migros 3.40/kg; savings 1.40/kg | Offers sorted Otto's, Denner, Migros; `comparisonUnit: "kg"`; savings `1.4` | PASS |
| R5 | `compare_prices` | `query: "pasta", comparisonBasis: "packPrice", quantity: 3` | Backward-compatible pack ranking: Otto's total 3.00, Denner 3.60, Migros 5.10; savings 2.10 | Offers sorted Otto's, Denner, Migros; `comparisonUnit: "pack"`; savings `2.1` | PASS |
| R6 | `lookup_store_product_availability` | `migros / migros-zurich-1 / "pasta", matchMode: "balanced"` | Migros supports lookup; Wholegrain Pasta matches but is not in store inventory; `isAvailable:false` | Single `migros-pasta-500g` match with `available:false`; `isAvailable:false` | PASS |

## Automated regression coverage

Date: 2026-05-18

The follow-up implementation also added or updated automated coverage for:

- `src/util/matcher.test.ts`: normalization, balanced taxonomy aliases,
  literal matching, and multi-token taxonomy matching.
- `src/adapters/staticChainAdapter.test.ts`: balanced/literal product search,
  match-strength ordering, and the exact-match availability guard.
- `src/services/searchService.test.ts`: default balanced cross-chain pasta
  recall and literal-mode fallback.
- `src/services/priceComparisonService.test.ts`: unit-price ranking,
  `limitPerChain` alternatives, and ineligible mixed/missing unit metadata.
- `src/tools/handlers.test.ts` and `src/index.integration.test.ts`: MCP tool
  schemas and end-to-end exposure for `matchMode` and `comparisonBasis`.

Verification commands run on 2026-05-18:

| Command | Result |
|---|---|
| `npm run lint` | PASS |
| `npm test -- --run` | PASS: 8 test files, 65/65 tests |
| `npm run build` | PASS |
