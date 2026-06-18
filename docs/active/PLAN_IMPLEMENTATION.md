# Implementation Plan: Denner Products, Store Search, Availability

## Quick Fixes Already Done (commit `1d2f450`)

| Fix | Files | What changed |
|-----|-------|-------------|
| Migros store 403 | `migrosLiveAdapter.ts` | Auth header: `authorization: Bearer` → `leshopch: token` (3 fetch calls) |
| Migros CHF 0.00 | `migrosLiveAdapter.ts`, `migros.ts`, `baseLiveAdapter.ts` | Removed `\|\| 0` price fallback; removed zero-price acceptance; added `price <= 0` guard |
| Otto's images | `ottos.ts` | Prefix relative URLs with `https://www.ottos.ch` |
| Otto's product link | `ottos.ts`, `ottosLiveAdapter.ts` | Added `url` field to interfaces; use API-provided URL instead of fabricated pattern |
| SPA comparison links | `index.html` | Wrap product names in `<a>` tags when `productUrl` exists |
| SPA Enter key | `index.html` | Added `keydown` listeners on all 3 search inputs |
| Google Maps | `index.html` | Replaced OpenStreetMap links with Google Maps |

---

## How Querying Works (Verified)

We call each vendor's own search/product API directly:

| Chain | Search API endpoint | Auth | Notes |
|-------|-------------------|------|-------|
| Migros | `onesearch-oc-seaapi` via `migros-api-wrapper` | Guest token via `leshopch` header | Two-step: `searchProduct` → `getProductDetails` |
| Coop | `coop.ch/rest/v2/coopathome/products/search/{query}` | None (DataDome protection) | Path-param search, iOS Safari UA bypasses bot detection |
| Otto's | `ottos.ch/occ/v2/ottos-de/products/search?query=...` | None | SAP Commerce Cloud API |
| Lidl | `lidlplus.com/api/v4/offers/{country}/search?query=...` | Bearer token (Lidl Plus OAuth) | Requires app auth flow |
| Denner | **No public search API** — only product detail + category/promotion listings | None | See Feature 1 below |
| Volg | WooCommerce `?s={query}&post_type=product` | None | Standard WooCommerce search |

---

## Complex Items — Implementation Plan

### Feature 1: Denner Product Search

**Current state:** Denner adapter only supports promotions (weekly action pages). No product search.

**API findings (from Chrome DevTools):**

Denner exposes two key endpoints:

1. **Product detail**: `GET https://www.denner.ch/api/product/{id}?variant={variantId}&locale=de&context=promotion`
   - Returns full product data: title, description, categories, images (`cdnUrl`), price (`sales.price.raw`), availability, eco-labels
   - Product URL pattern: `https://www.denner.ch/de/aktionen/{slug}~p{id}`

2. **Routing/category listing**: `GET https://www.denner.ch/api/headless/routing?url={encoded-category-url}`
   - Returns category pages with product listings
   - Can list products by category (e.g., `/de/aktionen/lebensmittel~c1144362`)

**Problem:** Denner doesn't expose a public search endpoint. When users type in the search box on denner.ch, the website uses an internal search that isn't publicly documented.

**Implementation options:**

**Option A: Category/promotion scraping (recommended — no auth needed)**
- Use the routing API to list products from categories/promotions
- Cache results and index them for search
- Limitation: only finds products that are in active promotions or specific categories

**Option B: Website search scraping**
- Scrape `https://www.denner.ch/de/search?q={query}` HTML page
- Parse the embedded JSON/HTML for product results
- Fragile — breaks if Denner changes their HTML structure

**Option C: Hybrid — routing + product detail**
- For known product IDs: use `/api/product/{id}` directly
- For category browsing: use `/api/headless/routing?url=...`
- For search: fall back to scraping the search page

**Recommended approach: Option A + C**
- Build a Denner product index from promotion/category pages
- Support direct product lookup by ID via `/api/product/{id}`
- Use scraped search page as a fallback

**Denner product data mapping:**
```
API field              → NormalizedProduct field
─────────────────────────────────────────────────
data.remoteId          → id
data.title             → name
data._tracking.item_brand → brand
data.sales.price.raw   → price.current
data.images[0].cdnUrl  → image
data.categories[0].title → category
jsonLd.offers.url      → productUrl
data.description       → size (contains weight/volume info)
```

---

### Feature 2: Coop Store Search Fix

**Research result:** The endpoint IS correct:
```
https://www.coop.ch/rest/v2/coopathome/locations/searchAroundCoordinates
```

Verified via:
- Direct HTTP test returns 200 with store data
- Same endpoint used in `nicktcode/swissgroceries-mcp` (verified via Charles Proxy from Coop iOS app)

**Why it wasn't working:**
1. Missing `currentPage=0` parameter (API may default to page 0, but explicit is safer)
2. DataDome bot protection blocks requests from server IPs — the `iosSafariUA` helps but isn't always enough
3. The `radius` parameter is ignored by the API — it returns all stores sorted by distance

**Required headers (from working implementation):**
```
User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148
Accept: application/json, text/plain, */*
Accept-Language: de-CH,de;q=0.9,en;q=0.8
```

**Fix plan:**
1. Add `currentPage=0` to query params
2. Add `Accept-Language: de-CH,de;q=0.9` header to `storeClient`
3. Update User-Agent to iOS 18.7 (newer = less likely blocked)
4. Remove `radius` parameter (API ignores it)
5. Add client-side radius filtering (haversine) after fetching results

**Files to modify:**
- `src/adapters/live/coopLiveAdapter.ts` — Update store search params and headers

---

### Feature 3: Lidl Store Search Fix

**Research result:** The correct endpoint is:
```
GET https://stores.lidlplus.com/api/v4/CH
```

Key findings:
- **v4** (not v2 as currently used)
- **No `query` parameter** — returns ALL Swiss stores as a JSON array
- **No authentication required** for store listing
- Uses `User-Agent: okhttp/5.3.2` header

**Fix plan:**
1. Change URL from `/api/v2/CH?query=...` to `/api/v4/CH`
2. Fetch all stores (small payload, ~188 stores)
3. Cache aggressively (store locations rarely change)
4. Filter client-side by matching query against store name, address, city, postal code
5. Use geographic proximity for ZIP code queries

**Files to modify:**
- `src/adapters/live/lidlLiveAdapter.ts` — Rewrite store search to fetch-all + filter pattern

---

### Feature 4: Migros/Coop Store-Level Availability

**Current state:** Both adapters return `supported: false` with stub implementations.

**Migros availability API (from DevTools):**
```
GET https://www.migros.ch/store-availability/public/v2/availabilities/products/{productId}?costCenterIds={storeId1,storeId2,...}
```

Response format:
```json
{
  "availabilities": [
    { "id": "0093900", "stock": 0 },
    { "id": "0094290", "stock": 31 },
    { "id": "0150054", "stock": 20 }
  ],
  "catalogItemId": 100031528
}
```

- `id` = store costCenterId (same as `storeId` from `searchStores`)
- `stock` = unit count (0 = unavailable)
- `catalogItemId` = Migros product ID (matches `remoteId`)

**Coop availability API (from DevTools):**
```
GET https://www.coop.ch/rest/v2/coopathome/products/{productId}/stockLevels?costCenterIds={storeId1,storeId2,...}
```

Response format (same structure as Migros):
```json
{
  "availabilities": [
    { "id": "0093900", "stock": 0 },
    { "id": "0094290", "stock": 31 }
  ],
  "catalogItemId": 100031528
}
```

**Implementation plan:**

1. **Add `lookupStoreProductAvailability` to Migros adapter:**
   - Input: `query` (product search), `storeId` (optional — specific store)
   - Step 1: Search for product → get `productId` (remoteId)
   - Step 2: If no `storeId`, search nearby stores first to get costCenterIds
   - Step 3: Call availability API with `productId` + comma-joined costCenterIds
   - Step 4: Return availability status for each store

2. **Add `lookupStoreProductAvailability` to Coop adapter:**
   - Same pattern as Migros but using Coop API endpoints
   - Uses `storeId` directly as `costCenterId`

3. **Update `getStoreAvailabilitySupport` to return `supported: true`** for both chains

**Files to modify:**
- `src/adapters/live/migrosLiveAdapter.ts` — Implement `lookupStoreProductAvailability`
- `src/adapters/live/coopLiveAdapter.ts` — Implement `lookupStoreProductAvailability`
- `src/adapters/types.ts` — May need to extend `StoreProductAvailabilityResult` with stock count

---

### Feature 5: Denner Store Search

**Current state:** Denner adapter returns `supported: false` for store search.

**API findings:** Denner has a store finder at `https://www.denner.ch/de/filialfinder` that uses their routing API. We need to capture the actual store search API call.

**Status:** Needs Chrome DevTools capture from user.

---

## Implementation Order

### Phase 1: Store search fixes (immediate)
1. **Coop store** — Add `currentPage=0`, update UA, remove radius, add Accept-Language
2. **Lidl store** — Switch to `/api/v4/CH`, fetch-all + client-side filter
3. **Migros store** — Already fixed (auth header), verify it works

### Phase 2: Denner product search
4. **Denner products** — Build adapter using routing API + product detail API
5. **Denner promotions** — Already exists, verify it works with new parser

### Phase 3: Availability (has API data)
6. **Migros availability** — Implement with `/store-availability/public/v2/` endpoint
7. **Coop availability** — Implement with `/products/{id}/stockLevels` endpoint
8. **Denner stores** — Needs DevTools capture from user

### Phase 4: Polish
9. **SPA: availability display** — Show availability in product cards when available
10. **SPA: Denner in chain filters** — Already supported, verify

---

## Coop Store Autocomplete (Bonus)

The user also captured Coop's store location autocomplete:
```
GET https://www.coop.ch/de/store-finder/get/locations/autocomplete?q=8303&count=5&onlyOpen=false
```

This returns village/street locations with lat/lng coordinates. We can use this instead of GeoAdmin for Coop store resolution — it's faster and more accurate for Coop-specific queries.

**Option:** Add Coop-native geocoding as a fallback when GeoAdmin fails.

---

## Files Summary

### New files
- `src/adapters/live/dennerLiveAdapter.ts` — Denner product search adapter

### Modified files
- `src/adapters/live/coopLiveAdapter.ts` — Store search fix + availability
- `src/adapters/live/lidlLiveAdapter.ts` — Store search rewrite
- `src/adapters/live/migrosLiveAdapter.ts` — Availability implementation
- `src/parsers/denner.ts` — Extend with product parsing
- `src/web/public/index.html` — Availability display in product cards
