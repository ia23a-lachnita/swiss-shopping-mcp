# SPA Browser Test Log

## Bugs Found and Fixed

### Browser Test Finding #1: Store Finder Missing Opening Hours
- **Reported by:** Loop 1, Test 1.12
- **Description:** Store finder results did not display opening hours on store cards
- **Fix:** Added `s.openingHours` rendering to store card innerHTML (`src/web/public/index.html:758`)
- **Status:** Fixed, verified in browser

### Browser Test Finding #2: Tab ID Mismatch  
- **Reported by:** Loop 1, Test 1.2
- **Description:** Test used `#tab-avail` but SPA uses `#tab-availability`
- **Fix:** Updated test assertions (not a SPA bug, just test mismatch)
- **Status:** Test corrected

### Browser Test Finding #3: Chain Badge Location
- **Reported by:** Loop 1, Tests 1.9, 1.10
- **Description:** Store cards don't have `.chain-badge` — badge is on `.chain-group-header`
- **Fix:** Updated test assertions to check group headers
- **Status:** Test corrected

### Browser Test Finding #4: Nutrition/Allergens Not Displayed on Product Cards
- **Reported by:** User manual testing (2026-06-21)
- **Description:** Nutrition and ingredients/allergens checkboxes had no visible effect. Products showed no nutrition data or allergens.
- **Root cause:** Stale file cache in OS temp dir contained products fetched before nutrition extraction was added to the Migros adapter. Also, SPA checked `p.ingredients` but adapter only populated `allergens`.
- **Fix:** 
  1. Clear stale cache after code changes
  2. SPA now checks `p.allergens || p.ingredients` for the Ingredients/Allergens section (`src/web/public/index.html:644`)
  3. Migros adapter correctly extracts nutrition from `productInformation.nutrientsInformation.nutrientsTable` and allergens from `productInformation.mainInformation.allergens`
- **Status:** Fixed, verified in browser (8/8 Playwright tests pass)

### Browser Test Finding #5: Availability Page Shows Only One Product With All Stores
- **Reported by:** User manual testing (2026-06-21)
- **Description:** Availability tab showed one product from one vendor with a list of stores saying "all out of stock" — confusing UX
- **Root cause:** `lookupAvailabilityByLocationProductsFirst()` only returned `[{product: firstProduct, stores}]` — only one product
- **Fix:** Rewrote to search for all products and find nearby stores in parallel, returning `[{product, stores}, ...]` for all products (`src/services/searchService.ts:374`)
- **Status:** Fixed, verified in browser — 10 products shown with 2-column grid

---

## Loop 1 — Feature Verification (18 tests)

| # | Test Case | Result |
|---|-----------|--------|
| 1.1 | Page loads with title and tabs | PASS |
| 1.2 | Tab navigation switches sections | PASS |
| 1.3 | Product search basic — returns product cards | PASS |
| 1.4 | Nutrition checkbox shows nutrition data on cards | PASS |
| 1.5 | Ingredients checkbox shows ingredients on cards | PASS |
| 1.6 | Toggle nutrition OFF hides nutrition data | PASS |
| 1.7 | Chain filter — Migros only | PASS |
| 1.8 | Chain filter — Coop only | PASS |
| 1.9 | Store Finder — Migros stores in Bern | PASS |
| 1.10 | Store Finder — Coop stores in Zurich | PASS |
| 1.11 | Store Finder — Multi-chain in Basel | PASS |
| 1.12 | Store opening hours displayed | PASS |
| 1.13 | Price Comparison returns offers | PASS |
| 1.14 | Availability — Products-first view | PASS |
| 1.15 | Source Status shows chain capabilities | PASS |
| 1.16 | Empty search query shows error | PASS |
| 1.17 | Empty store location shows error | PASS |
| 1.18 | Empty availability query shows error | PASS |

**Result: 18/18 PASS**

---

## Loop 2 — Deep Edge Cases (20 tests)

| # | Test Case | Result |
|---|-----------|--------|
| 2.1 | Unicode search query (Müesli) | PASS |
| 2.2 | Multiple sequential searches retain correct state | PASS |
| 2.3 | Nutrition toggle persists across searches | PASS |
| 2.4 | Store finder with postal code 8001 | PASS |
| 2.5 | Availability with in-stock filter | PASS |
| 2.6 | Availability with open-now filter | PASS |
| 2.7 | Price comparison with quantity > 1 | PASS |
| 2.8 | Product search — max price filter | PASS |
| 2.9 | Error recovery — search fails then succeeds | PASS |
| 2.10 | Store finder error recovery | PASS |
| 2.11 | Limit selector works — limit 5 returns fewer results | PASS |
| 2.12 | Product cards have vendor links | PASS |
| 2.13 | Store cards have map links | PASS |
| 2.14 | Source status shows all 8 chains | PASS |
| 2.15 | Source status shows live-beta badges | PASS |
| 2.16 | Search limit 20 | PASS |
| 2.17 | Tab switching during loading cancels gracefully | PASS |
| 2.18 | All chain checkboxes in store finder | PASS |
| 2.19 | Availability chain checkboxes exist | PASS |
| 2.20 | Price comparison chain checkboxes exist | PASS |

**Result: 20/20 PASS**

---

## Bug Fix Verification — Loop 3 (8 tests)

| # | Test Case | Result |
|---|-----------|--------|
| 3.1 | Product search shows nutrition data for Migros | PASS |
| 3.2 | Product search shows allergens/ingredients for Migros | PASS |
| 3.3 | Nutrition checkbox toggles nutrition display | PASS |
| 3.4 | Ingredients checkbox toggles ingredients display | PASS |
| 3.5 | Availability page shows multiple products in 2-column grid | PASS |
| 3.6 | Availability page shows nutrition on product cards | PASS |
| 3.7 | Availability page shows store availability summary per product | PASS |
| 3.8 | Store finder shows opening hours | PASS |

**Result: 8/8 PASS**

---

## Summary

- **Total browser tests:** 46 (18 + 20 + 8)
- **Passing:** 46
- **Failed:** 0
- **Bugs found:** 5 (all fixed)
  - #1: Store finder missing hours
  - #4: Nutrition/allergens not displayed (stale cache + wrong field name)
  - #5: Availability page single-product UX
- **vitest unit/integration tests:** 474 passing
