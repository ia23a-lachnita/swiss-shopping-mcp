# Plan: Store Finder Fix + Dynamic Taxonomy + Product URL SPA

## Issues

### Issue 1: Store Finder — Migros/Coop not returning stores for "8303"

**Root cause analysis:**

| Chain | Status | Root cause |
|-------|--------|-----------|
| Otto's | Works | Simple unauthenticated `?query=X` endpoint, no bot protection |
| Lidl | Should work | Same pattern as Otto's — unauthenticated `?query=X` |
| Migros | Failing | Store API requires Bearer token auth; direct `fetch()` call may be failing (auth expired, token invalid, or API error) |
| Coop | Failing | Store search uses `sourceClient.fetchJson()` with default user agent `swiss-shopping-mcp/0.1`. DataDome anti-bot detects and blocks it. Product search works because it uses `iosSafariUA` via `fetchText()`. Store search does NOT pass custom UA. |
| Aldi | Unsupported | Store lookup not implemented (expected) |
| Denner | Unsupported | Store lookup not implemented (expected) |
| Volg | Empty | Delivery-only, no physical stores (expected) |

**Fix plan:**

1. **Coop store search** (`src/adapters/live/coopLiveAdapter.ts`):
   - Pass `iosSafariUA` via `init.headers` in the `fetchJson()` call for store search
   - Currently line 246-251: `this.sourceClient.fetchJson<CoopStoresResponse>(storesUrl, { ... })` has no `init` option
   - Fix: Add `init: { headers: { 'user-agent': IOS_SAFARI_UA } }` to the fetch options
   - This matches how product search already works (which successfully uses `fetchText()` with the same UA)

2. **Migros store search** (`src/adapters/live/migrosLiveAdapter.ts`):
   - The adapter already uses direct `fetch()` with Bearer token (lines 369-376)
   - Add a `iosSafariUA` header to the fetch call to match the Migros mobile API expectations
   - Add fallback: if coordinates-based search fails, try text-only search (no coordinates) as a second attempt before giving up
   - Log the actual error message for debugging

3. **SPA store rendering** (`src/web/public/index.html`):
   - Currently shows "Showing X of Y chains responded" but the message is easy to miss
   - Add per-chain status badges (green check / red X / yellow warning) next to each store group header
   - Already partially implemented via `renderChainSummary()` — verify it's working for stores

### Issue 2: Product URL clicking in SPA

**Status:** Already partially implemented!

- `NormalizedProduct` has `productUrl?: string` field
- SPA already renders clickable `<a>` links when `productUrl` is present (lines 547-554)
- Migros, Coop, Otto's, Volg, Aldi adapters already populate `productUrl`

**What's missing:**
- Verify `productUrl` is actually being returned in the API response (check `searchService` → `web/server.ts` → SPA)
- If missing, check if `search_products` tool strips it before returning
- The SPA already handles it correctly — just need to verify the data flows through

### Issue 3: Dynamic taxonomy (replace static TAXONOMY in matcher.ts)

**Current state:** Static `TAXONOMY` object with 25 categories and hardcoded German/English synonyms.

**Plan:** Build taxonomy dynamically from product data at search time.

**Approach:**

1. **New file:** `src/util/taxonomyBuilder.ts`
   - `buildTaxonomy(products: NormalizedProduct[]): Record<string, string[]>`
   - Scans all product names, brands, categories, and tags across the result set
   - Groups tokens by semantic similarity (exact match on normalized tokens)
   - For each unique token found in products, collects all products that contain it
   - Builds reverse mapping: `token → [related tokens]` based on co-occurrence in same products

2. **Integration point:** `src/services/searchService.ts`
   - After fetching products from adapters, build dynamic taxonomy from the raw results
   - Pass taxonomy to `sortProducts()` and `calculateMatchStrength()`
   - Keep static TAXONOMY as a seed/fallback for queries that match zero products

3. **Changes to `src/util/matcher.ts`:**
   - `calculateMatchStrength()` and `sortProducts()` accept optional `taxonomy` parameter
   - If no taxonomy provided, falls back to static TAXONOMY
   - `getAliases()` also accepts optional taxonomy parameter

4. **Search flow:**
   ```
   1. User queries "zitrone"
   2. searchService.fetchProducts() → returns 50 products from all chains
   3. buildTaxonomy(products) → discovers "zitrone" co-occurs with "citrus", "limette", "obst"
   4. sortProducts(products, "zitrone", taxonomy) → ranks zitrone matches highest
   5. If 0 products found, fall back to static TAXONOMY for expansion
   ```

## Files to modify

| File | Change |
|------|--------|
| `src/adapters/live/coopLiveAdapter.ts` | Add `iosSafariUA` header to store search fetch |
| `src/adapters/live/migrosLiveAdapter.ts` | Add `iosSafariUA` header to store fetch, add text-only fallback |
| `src/util/taxonomyBuilder.ts` | **NEW** — Dynamic taxonomy builder |
| `src/util/taxonomyBuilder.test.ts` | **NEW** — Tests for taxonomy builder |
| `src/util/matcher.ts` | Accept optional `taxonomy` parameter in functions |
| `src/util/matcher.test.ts` | Add tests for dynamic taxonomy |
| `src/services/searchService.ts` | Build dynamic taxonomy after fetching products |
| `src/web/public/index.html` | Verify product URL linking works end-to-end |
| `src/index.ts` | Update MCP tool handlers if taxonomy param needed |

## Verification

1. `pnpm lint && pnpm test && pnpm build`
2. Start SPA, search "8303" in store finder → should show Migros + Coop + Otto's stores
3. Search products → click a product → should open vendor page in new tab
4. Search "zitrone" → should find citrus-related products via dynamic taxonomy
