# Sprint Plan — 2026-06-18

## Phase 1: Small Fixes (Quick Wins)

### Fix 1: Remove Farmy from SPA chain filters
- **What:** Farmy is blocked (operations ceased) but still shows in all SPA chain filter checkboxes
- **Files:** `src/web/public/index.html` (remove from `ALL_CHAINS`), `src/adapters/sourceRegistry.ts` (keep for status page)
- **Change:** Remove `'farmy'` from the `ALL_CHAINS` JS array in the SPA. Keep it in the source registry so the status page still shows it as blocked.
- **Effort:** Trivial

### Fix 2: Update source status page to reflect current adapter state
- **What:** The source status page is outdated. Migros nutrition is marked `unsupported` but the adapter actually populates it. Several statuses are stale.
- **Files:** `src/adapters/sourceRegistry.ts`
- **Changes:**
  - Migros `nutrition`: change to `live-beta` (adapter has `nutrition_facts` parsing wired through)
  - Coop `nutrition`: keep `unsupported` (parser never populates it, wire is dead)
  - Verify all other statuses match actual adapter capabilities
- **Effort:** Small

### Fix 3: Denner product search — fix wrong results
- **What:** Searching "wein" on the SPA returns a sausage product. The Prediggo API returns different blocks (PRODUCT, CONTENT_3 for wine) and the adapter only reads `searches[0].slots`. Need to merge slots from all search blocks.
- **Files:** `src/parsers/denner.ts` (`parseDennerSearchApiResponse`), `src/adapters/live/dennerPromotionsAdapter.ts`
- **Root cause:** The Prediggo response has `blocks.searches` as an array of blocks. The current parser reads only the first block's slots. Wine results are in a later block (CONTENT_3). Also the product block may have 5 results but CONTENT_3 has 5 wine results — both are valid.
- **Change:** Iterate ALL blocks in `searches` and merge their slots, deduplicating by tracking ID.
- **Effort:** Small

### Fix 4: Store finder — debug and fix Migros/Coop not returning results
- **What:** Only Otto's shows in store finder results. Migros and Coop adapters have store search code but likely fail at runtime.
- **Investigation needed:** Run live test to see actual errors. Likely causes:
  - Migros: guest token auth failure or `searchStores()` returning unexpected shape
  - Coop: DataDome blocking despite iOS Safari UA
- **Files:** `src/adapters/live/migrosLiveAdapter.ts`, `src/adapters/live/coopLiveAdapter.ts`
- **Change:** Fix based on actual error. May need to adjust auth flow, response parsing, or add better error surfacing.
- **Effort:** Medium (investigation + fix)

---

## Phase 2: Bigger Features

### Feature 1: Redesign availability tab — postal code + store list
- **What:** Replace the store-ID-required availability tab with a store-finder-like UX:
  1. User enters product query + postal code (not store ID)
  2. System finds nearby stores (like store finder does)
  3. For each store, checks product availability
  4. Shows results grouped by chain, with availability badges (in stock / out of stock)
  5. Filters: "in stock only" toggle, "currently open" toggle
  6. Maps links on each store card
  7. Opening hours displayed on store cards
- **Backend changes:**
  - New API endpoint `POST /api/store-availability` that takes `{ query, location, chains?, inStockOnly?, openNow? }`
  - Orchestrates: geocode location → find stores → for each store with availability support, lookup product availability → merge results
  - Parse opening hours to determine "currently open" status
- **SPA changes:**
  - Rewrite availability tab form: location input + product query + filters
  - Render stores with availability badges, opening hours, maps links
  - Add "in stock only" and "currently open" filter toggles
- **Type changes:**
  - Add `StoreWithAvailability` type extending `NormalizedStore` with availability info
  - Add structured opening hours parsing utility
- **Files:** `src/web/server.ts`, `src/web/public/index.html`, `src/services/searchService.ts`, `src/adapters/types.ts`
- **Effort:** High

### Feature 2: Product quantity/metric display
- **What:** Show the product quantity (e.g., "500g", "1l", "6 x 430g") on product cards and in price comparison table.
- **Data availability:**
  - Migros: `price.unit` has `{value, per}` — structured ✓
  - Coop: `price.unit` has `{value, per}` — structured ✓
  - Denner: `size` is free-text (e.g., "75 cl", "6 x 430g") — needs parsing
  - Aldi/Lidl/Otto's/Volg: no quantity data in their APIs
- **Changes:**
  - Add `NormalizedProduct.size` display to SPA product cards and comparison table
  - Parse Denner's `content_size_text` into structured `price.unit` format
  - For Aldi/Lidl/Otto's/Volg: attempt to extract quantity from product name (regex patterns for common Swiss formats)
- **Files:** `src/web/public/index.html`, `src/parsers/denner.ts`, `src/parsers/aldi.ts`, `src/parsers/lidl.ts`, `src/parsers/ottos.ts`, `src/parsers/volg.ts`
- **Effort:** Medium

### Feature 3: Macros (nutrition) per 100g/100ml display
- **What:** Show nutrition data (energy, protein, carbs, fat, fiber, sugar) per 100g/100ml on expandable product cards. Only for food items. Toggle in query area to expand all cards.
- **Data availability:**
  - Migros: HAS nutrition data from `nutrition_facts` API field ✓
  - Coop: Wire exists but parser never populates — need to check Coop API for nutrition fields
  - Denner: Prediggo API has NO nutrition attributes in search index
  - Aldi: Product pages may have nutrition in HTML (need to check)
  - Others: No nutrition data available
- **Changes:**
  - Add expandable "Nutrition" section to SPA product cards (collapsed by default)
  - Add "Show all nutrition" toggle in product search query area
  - Normalize nutrition to per-100g/100ml basis (need serving size from Migros API)
  - Update source registry for Migros nutrition to `live-beta`
  - Investigate Coop/Aldi product pages for nutrition HTML
- **Files:** `src/web/public/index.html`, `src/parsers/migros.ts`, possibly `src/parsers/coop.ts`, `src/parsers/aldi.ts`
- **Effort:** High

### Feature 4: Ingredients display
- **What:** Show product ingredients/contents on expandable product cards. Only for food items. Toggle in query area.
- **Data availability:**
  - Migros: Need to check if `nutrition_facts` response also includes ingredients
  - Coop: Need to check product detail API for ingredients
  - Denner: Prediggo API has NO ingredients in search index; product detail page may have them
  - Aldi: Product pages may have ingredients in HTML
  - Others: No ingredients data
- **Changes:**
  - Add `ingredients?: string[]` to `NormalizedProduct` type
  - Add expandable "Ingredients" section to SPA product cards
  - Add "Show all ingredients" toggle in product search query area
  - Investigate which adapters can provide ingredients data
  - Populate ingredients in adapters where possible
- **Files:** `src/adapters/types.ts`, `src/web/public/index.html`, adapter files TBD
- **Effort:** High (investigation + implementation)

---

## Implementation Order

| Step | Item | Type | Depends On |
|------|------|------|------------|
| 1 | Fix 1: Remove Farmy from SPA | Quick fix | — |
| 2 | Fix 2: Update source registry | Quick fix | — |
| 3 | Fix 3: Denner search results | Quick fix | — |
| 4 | Fix 4: Migros/Coop store finder | Investigation + fix | — |
| 5 | Feature 2: Quantity display | Feature | — |
| 6 | Feature 1: Availability redesign | Feature | Fix 4 (needs working store finder) |
| 7 | Feature 3: Macros display | Feature | Feature 2 (card UI reuse) |
| 8 | Feature 4: Ingredients display | Feature | Feature 3 (card UI reuse) |

## Data Source Summary

| Chain | Nutrition | Ingredients | Quantity | Store Search | Availability |
|-------|-----------|-------------|----------|-------------|-------------|
| **Migros** | ✓ (API `nutrition_facts`) | TBD (check API) | ✓ (`price.unit`) | ✓ (wrapper) | ✓ (`/store-availability/`) |
| **Coop** | ✗ (dead wire) | TBD (check API) | ✓ (`contentUnit`) | ✓ (REST API) | ✓ (`/stockLevels`) |
| **Aldi** | ✗ | TBD (check HTML) | ✗ | ✗ | ✗ |
| **Denner** | ✗ (Prediggo has none) | TBD (check PDP) | ✓ (free-text `size`) | ✗ | ✗ |
| **Lidl** | ✗ | ✗ | ✗ | ✓ (Lidl Plus API) | ✗ |
| **Otto's** | ✗ | ✗ | ✗ | ✓ (OCC API) | ✗ |
| **Volg** | ✗ | ✗ | ✗ | ✗ (delivery-only) | ✗ |
