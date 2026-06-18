# Implementation Plan: Denner Products, Store Search, Availability

## Status: Complete

All planned features have been implemented. Denner now uses the Prediggo search API (`POST /search-api/simplePageContent`) for product search. Migros and Coop have store-level availability. The SPA includes an availability check tab.

---

## How Querying Works

| Chain | Search API endpoint | Auth | Notes |
|-------|-------------------|------|-------|
| Migros | `onesearch-oc-seaapi` via `migros-api-wrapper` | Guest token via `leshopch` header | Two-step: `searchProduct` → `getProductDetails` |
| Coop | `coop.ch/rest/v2/coopathome/products/search/{query}` | None (DataDome protection) | Path-param search, iOS Safari UA bypasses bot detection |
| Otto's | `api.ottos.ch/occ/v2/ottos/products/search?query=...` | None | SAP Commerce Cloud API |
| Denner | `POST denner.ch/search-api/simplePageContent` | None | Prediggo search API, POST with query body |
| Lidl | `lidlplus.com/api/v4/offers/{country}/search?query=...` | Bearer token (Lidl Plus OAuth) | Requires app auth flow |
| Volg | WooCommerce `?s={query}&post_type=product` | None | Standard WooCommerce search |

---

## Features Implemented

### Feature 1: Denner Product Search
**Status: Done**

Used Prediggo search API: `POST https://www.denner.ch/search-api/simplePageContent`

Request body:
```json
{
  "moduleVersion": "D2.0",
  "sessionId": "denner-<timestamp>",
  "region": "de_CH",
  "advanced": { "device": "COMPUTER" },
  "parameters": { "query": "<search query>" },
  "pageId": 9
}
```

Response parsed from `blocks.searches[0].slots[]`:
- `item.sku` → UUID
- `item.price` → numeric price
- `item.attributeInfo[]` → attributes array:
  - `name` → product name
  - `imageUrl` → imgix CDN URL (`https://denner.imgix.net/...`)
  - `itemUrl` → product URL path
  - `_tracking_item_id` → Denner product ID
  - `category` → category labels
  - `content_size_text` → size/weight
  - `availability` → availability score
  - `isBuyable` → buyable flag

**Files modified:**
- `src/parsers/denner.ts` — Added `parseDennerSearchApiResponse()` parser
- `src/adapters/live/dennerPromotionsAdapter.ts` — Replaced HTML scraping with Prediggo API, removed `searchProductsFromSearchPage` and `searchProductsFromCategory`, added `searchProductsFromSearchApi`

### Feature 2: Coop Store Search Fix
**Status: Done**

- Added `currentPage=0` parameter
- Added `Accept-Language: de-CH,de;q=0.9` header
- Updated User-Agent to iOS 18.7
- Removed ignored `radius` parameter
- Parser handles both `geoPoint` and `location` response formats

### Feature 3: Lidl Store Search Fix
**Status: Done**

- Switched to v4 API: `GET stores.lidlplus.com/api/v4/CH`
- Fetches all stores (no query param)
- Client-side filtering by name/address
- Cache shared as `lidl:stores:all`

### Feature 4: Migros/Coop Store-Level Availability
**Status: Done**

**Migros:**
- Endpoint: `GET https://www.migros.ch/store-availability/public/v2/availabilities/products/{productId}?costCenterIds=...`
- Response: `{ availabilities: [{ id, stock }], catalogItemId }`

**Coop:**
- Endpoint: `GET https://www.coop.ch/rest/v2/coopathome/products/{productId}/stockLevels?costCenterIds=...`
- Same response format as Migros

**Files modified:**
- `src/adapters/live/migrosLiveAdapter.ts` — Implemented `lookupStoreProductAvailability()`
- `src/adapters/live/coopLiveAdapter.ts` — Implemented `lookupStoreProductAvailability()`
- `src/web/server.ts` — Added `POST /api/availability` endpoint
- `src/web/public/index.html` — Added Availability tab with store ID input

### Feature 5: Denner Store Search
**Status: Not possible** — Denner website has no store finder functionality.

### Feature 6: Otto's Images
**Status: Done**

- Otto's OCC backend at `api.sherpaoutdoor.com` serves images, not `www.ottos.ch`
- Changed image URL prefix from `https://www.ottos.ch` to `https://api.sherpaoutdoor.com`
- Otto's price fix: `parseFormattedPrice()` now strips Swiss apostrophe (`'`) thousands separator

### Feature 7: Migros Store 403 Fix
**Status: Done**

- Removed direct `fetch()` bypass (TLS fingerprint mismatch)
- Uses `migros-api-wrapper`'s `searchStores()` for all queries
- Wrapper uses axios with TLS 1.3

---

## Remaining Items

| Item | Status |
|------|--------|
| Run contract tests (`RUN_CONTRACT_TESTS=1`) | Not yet done |
| Run live smoke tests (`LIVE_SOURCE_TESTS=1`) | Not yet done |
| Denner store search | Not possible — no API |

---

## Key Decisions

- **Migros search→details two-step**: `searchProduct` returns `productIds` only; must call `getProductDetails` for full data
- **Migros product price**: `product.offer.price.effectiveValue`
- **Migros store auth**: `leshopch: <token>` header via `migros-api-wrapper`
- **Coop search uses path parameter**: `/products/search/{query}`
- **Coop stores require lat/lng**: Uses `resolveLocationAsync()` → `searchAroundCoordinates`
- **Lidl campaigns API limitation**: Only metadata, no individual products/prices
- **Otto's product URLs**: API returns correct URL in `product.url` field
- **Otto's images**: OCC backend `api.sherpaoutdoor.com` serves images; `www.ottos.ch` serves SPA shell
- **Denner search**: Prediggo API returns structured JSON; no need for HTML scraping
- **Denner store search**: Not available — website has no store finder
- **Availability**: Both Migros and Coop support store-level stock queries via REST API
