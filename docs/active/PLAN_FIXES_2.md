# Plan: Fix Remaining Issues — Store Search, Product Quality, SPA UX

## Issue 1: Migros store search returns 403

**Root cause:** Wrong auth header. The direct `fetch()` calls in `findStores` send `authorization: Bearer <token>` but the Migros API expects a custom header `leshopch: <token>`.

The `migros-api-wrapper` sends `leshopch` correctly (see `headers.ts` in the wrapper), but the adapter bypasses the wrapper to pass coordinates — and uses the wrong header in the bypass.

**Fix:** Change all 3 `fetch()` calls in `migrosLiveAdapter.ts` `findStores` from:
```typescript
authorization: `Bearer ${token}`,
```
to:
```typescript
leshopch: token,
```
Lines: 374, 416, 443 (initial, retry, fallback).

---

## Issue 2: Coop store search not returning results

**Root cause:** The Coop store API endpoint path is likely wrong. Current URL:
```
https://www.coop.ch/rest/v2/coopathome/locations/searchAroundCoordinates?latitude=...&longitude=...&radius=5000
```
This endpoint may not exist or may have changed. Coop's SAP Hybris API typically uses different paths.

**Fix needed:** Research the correct Coop store API endpoint. Options:
- Try `stores/search?query=...` or `stores/searchByLocation`
- Check if the `iosSafariUA` is sufficient or if additional headers are needed
- The geo resolution works (returns valid coords for 8303)

**Status:** Needs API research before fixing.

---

## Issue 3: Lidl store search not returning results

**Root cause:** The Lidl Plus store API at `stores.lidlplus.com/api/v2/CH` may require authentication or may have changed its response format. The implementation mirrors Otto's pattern but the API itself may not be publicly accessible.

**Status:** Needs API research. Lower priority than Migros/Coop.

---

## Issue 4: Migros product shows CHF 0.00 when unavailable

**Root cause:** Two-step defect:

1. `migrosLiveAdapter.ts:286` — `normalizeProductDetail()` fabricates `amount: 0` when `offer.price.effectiveValue` is missing:
   ```typescript
   Number(priceData.effectiveValue) || 0  // Number(undefined) || 0 = 0
   ```

2. `migros.ts:116-119` — `parsePrice()` explicitly accepts 0 as valid price:
   ```typescript
   if (Number.isFinite(amount) && amount === 0) {
     return { current: 0, currency };
   }
   ```

Products with no valid price pass through all filters and sort to the top (cheapest first).

**Fix:**
- `migrosLiveAdapter.ts:286` — Remove `|| 0` fallback. Let it be `undefined` when no price exists.
- `migros.ts:116-119` — Remove the zero-price acceptance block. Let `parsePrice()` return `undefined` for 0 values.
- `baseLiveAdapter.ts` `productMatches()` — Add defensive guard: `if (product.price.current <= 0) return false;`

---

## Issue 5: Otto's images not showing

**Root cause:** Otto's OCC API returns image URLs as relative paths (`/medias/product-main-305754-01?...`). The parser at `src/parsers/ottos.ts:105` extracts them as-is without prefixing the domain.

**Fix:** In `src/parsers/ottos.ts`, prefix relative image URLs:
```typescript
const rawImage = product.images?.[0]?.url;
const image = rawImage?.startsWith('/') ? `https://www.ottos.ch${rawImage}` : rawImage;
```

---

## Issue 6: Otto's product link opens "not found"

**Root cause:** `ottosLiveAdapter.ts:52` fabricates wrong URL pattern (`/de/product/{id}`). Otto's API returns the correct URL in `product.url` (e.g., `/beauty-gesundheit/.../p/305754`), but:
1. `OttosOccProduct` interface is missing the `url` field
2. `OttosParsedProduct` interface is missing the `url` field
3. `parseOttosOccProduct` doesn't extract `product.url`
4. `toNormalizedProduct` hardcodes a fabricated URL

**Fix (4 changes across 2 files):**
- `src/parsers/ottos.ts` — Add `url?: string` to both interfaces, extract `product.url` in parser
- `src/adapters/live/ottosLiveAdapter.ts:52` — Use `product.url ? 'https://www.ottos.ch' + product.url : undefined`

---

## Issue 7: Price comparison has no clickable product links

**Root cause:** `src/web/public/index.html:753` renders product names as plain text in the comparison table. The `productUrl` field is available on `o.product` but never used.

**Fix:** Wrap product name in `<a>` tag when `o.product.productUrl` exists:
```javascript
'<td>' + (o.product.productUrl
  ? '<a href="' + escapeHtml(o.product.productUrl) + '" target="_blank" rel="noopener">' + escapeHtml(o.product.name) + '</a>'
  : escapeHtml(o.product.name)) + '</td>'
```

---

## Issue 8: Enter key doesn't trigger search

**Root cause:** No `keydown` event listeners on any input elements. Only `click` handlers on buttons.

**Fix:** Add Enter key listeners to the 3 search inputs:
- `#search-query` → trigger `#search-btn` click
- `#store-location` → trigger `#store-btn` click
- `#compare-query` → trigger `#compare-btn` click

```javascript
document.getElementById('search-query').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('search-btn').click();
});
```

---

## Issue 9: Store/product availability not implemented

**Root cause:** Both Migros and Coop adapters return `supported: false` for `getStoreAvailabilitySupport()` and `lookupStoreProductAvailability()`. These are stub implementations.

**Status:** Feature not yet implemented. Needs:
- Migros: Store-level stock data from `productId` + `storeId` endpoint
- Coop: Store-level stock data from availability API
- This is a new feature, not a bug fix.

---

## Implementation Order

### Quick fixes (no research needed)
1. **Migros 403** — Change auth header to `leshopch` (1-line fix × 3)
2. **Migros 0-price** — Remove `|| 0` fallback + zero-price acceptance + add min-price guard
3. **Otto's images** — Prefix relative URLs in parser
4. **Otto's product URL** — Use API-provided URL field
5. **SPA: comparison links** — Wrap product names in `<a>` tags
6. **SPA: Enter key** — Add keydown listeners

### Needs research
7. **Coop store API** — Find correct endpoint
8. **Lidl store API** — Find if API is accessible

### New feature (separate plan)
9. **Migros/Coop availability** — Store-level product availability
