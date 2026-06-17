# Plan: Fix Adapter URLs to Use Real APIs + Test Suite Improvements

## Problem Statement

All adapter URLs are wrong — they point to website pages instead of the actual JSON APIs that power those websites. As a result:
- Product search only returns Aldi results (the only adapter using working scraping)
- Store finder fails for all chains except Aldi
- Price comparison only returns Aldi
- Source status works (after routing fix) but shows failures for all chains

The test suite never surfaced this because every adapter test mocks `SourceHttpClient` with canned responses. The "production-pattern" tests also mock the network. Tests verify parsing logic but never validate that the real endpoints return the expected JSON shape.

## Research Findings

From analyzing two working Swiss grocery MCPs (`nicktcode/swissgroceries-mcp` and `lewpgs/migros-mcp`):

| Chain | Current URL (broken) | Real API (working) |
|-------|---------------------|-------------------|
| Migros | `migros.ch/de/produkte` (HTML) | `migros-api-wrapper` npm package → guest token → internal API |
| Coop | `coop.ch/de/search` (403) | `coop.ch/rest/v2/coopathome` + iOS User-Agent |
| Lidl | `lidl.ch/de/angebote` (404) | `digital-leaflet.lidlplus.com/api/v1/CH/campaignGroups` |
| Volg | `volgshop.ch/de/search` (404) | `volgshop.ch/wp-json/wc/store/v1/products` (WooCommerce) |
| Otto's | `ottos.ch/de/search` (HTML) | `api.ottos.ch/occ/v2/ottos/products/search` (OCC v2) |

Aldi and Denner already work (JSON-LD scraping and content API respectively).

## Changes

### Phase 1: Fix Adapter URLs (5 adapters)

#### 1.1 Migros — Use `migros-api-wrapper`

**Why**: The wrapper handles guest token auth, internal API paths, and response shapes. No need to reimplement.

**Integration constraint**: The wrapper does its own HTTP calls internally — it cannot accept a custom `fetch` implementation. We must manually integrate with our infrastructure layer:

- **Caching**: After each wrapper call, store the result in `FileTtlCache` using the same `cacheableProvenance` pattern as other adapters. On subsequent calls, check cache first (via `loadJson`/`loadText` pattern), only call the wrapper on cache miss.
- **Circuit breaker**: Wrap wrapper calls in try/catch. On failure, increment the circuit breaker via `sourceWarningFromError`. On success, reset the breaker. The adapter should surface warnings through `metadata.sourceWarnings` like other adapters.
- **Stale cache fallback**: If the wrapper call fails and cache has stale data, return the stale result with a `staleCacheWarning` — same pattern as `baseLiveAdapter.ts`.

**Guest token lifecycle**: The `ensureAuth()` pattern lazily obtains a guest token on first call. On 401/403, invalidate the cached token and re-auth once. For long-running processes, the wrapper internally caches the token for its session lifetime. If the token expires mid-session (rare), the adapter catches the auth error, calls `invalidateAuth()`, re-auths, and retries once.

**Pagination**: The `migros-api-wrapper` `searchProduct()` returns a list of product IDs (no built-in pagination). We slice the ID list using `offset` and `limit` before calling `getProductDetails()`. For limits > the number of returned IDs, we return what's available. For `findStores()`, the wrapper returns a plain array — apply `limit` filter client-side.

**Changes**:
- `package.json`: Add `migros-api-wrapper` dependency
- `src/adapters/live/migrosLiveAdapter.ts`: Replace `loadJson` HTTP calls with `MigrosAPI` wrapper, wrapped with cache + circuit breaker integration
  - Constructor: instantiate `MigrosAPI`
  - `searchProducts()`: Check cache → on miss call wrapper → cache result → return with provenance
  - `findStores()`: Same cache-first pattern
  - Add lazy guest token auth with `ensureAuth()` + `invalidateAuth()` for 401 retry
  - Region ID: Default to `"2"` (Genossenschaft Zürich), configurable via `SWISSGROCERIES_MIGROS_REGION_ID` env
- `src/parsers/migros.ts`: Update to handle `migros-api-wrapper` response shapes (different from assumed JSON)
- `src/adapters/live/migrosLiveAdapter.test.ts`: Update mocks to match wrapper API

**Reference**: `nicktcode/swissgroceries-mcp/src/adapters/migros/index.ts`

#### 1.2 Coop — Use REST API with iOS User-Agent

**Why**: `coop.ch/de/search` returns 403 (DataDome). The REST API at `coop.ch/rest/v2/coopathome` works with an iOS Safari User-Agent.

**DataDome fallback strategy**: DataDome may still block requests if rate-limited. The adapter should:
1. Map DataDome-specific errors (403 with `DataDome` in body/headers) to `{ code: 'rate_limited' }` or `{ code: 'unavailable', reason: 'DataDome blocked' }`
2. Surface these as `sourceWarnings` so the SPA shows "Coop: DataDome bot protection active"
3. Support `SWISSGROCERIES_USER_AGENT_COOP` env var to override the User-Agent if the default gets blocked

**Pagination**: Map the MCP `limit` parameter to the API's `pageSize`:
- `searchProducts({ limit: 20 })` → `pageSize=20`
- `searchProducts({ limit: 50 })` → `pageSize=50` (max 100 per OCC v2)
- For limits > 100, paginate and merge results

**Changes**:
- `src/adapters/live/coopLiveAdapter.ts`: Change base URL, add User-Agent, add pagination mapping
  - Base URL: `https://www.coop.ch/rest/v2/coopathome`
  - Add headers: `User-Agent` (iOS Safari, configurable via env), `Accept: application/json`
  - `searchProducts()`: `/products/search/{query}?currentPage=0&pageSize={limit}&query=availableOnline:false`
  - `findStores()`: `/locations/searchAroundCoordinates?latitude=X&longitude=Y` (requires geo coords — fall back to Swiss center [47.3769, 8.5417] if no location provided)
  - Error mapping: Detect DataDome blocks → `{ code: 'unavailable', reason: 'DataDome bot protection' }`
- `src/parsers/coop.ts`: Update to match actual Coop REST API response shape
- `src/adapters/live/coopLiveAdapter.test.ts`: Update URL expectations, add DataDome error test

**Reference**: `nicktcode/swissgroceries-mcp/src/adapters/coop/client.ts`

#### 1.3 Lidl — Use Lidl Plus App API

**Why**: `lidl.ch/de/angebote` returns 404. The Lidl Plus app API has campaign/leaflet data.

**Known limitation (must document in tool metadata)**: The Lidl Plus API only exposes **weekly promotional leaflet items**, not the full product catalog. Basic items like milk, bread, or eggs will not appear in results. This limitation must be:
1. Documented in the `search_products` tool description for Lidl
2. Surfaced in adapter metadata: `summary: 'Lidl data covers weekly promotional leaflet only — full catalog not available via public API'`
3. Reflected in `sourceRegistry.ts` capability status

**Pagination**: Lidl campaigns return all products at once (no pagination). Apply `limit` filter client-side after matching.

**Changes**:
- `src/adapters/live/lidlLiveAdapter.ts`: Change to use Lidl Plus API
  - Product search: `digital-leaflet.lidlplus.com/api/v1/CH/campaignGroups` → load campaigns → filter products client-side by query
  - Store search: `stores.lidlplus.com/api/v2/CH?latitude=X&longitude=Y&radius=R`
  - Add iOS app User-Agent headers (Lidl Social Internacional UA)
  - Apply `limit` filter client-side on matched products
- `src/parsers/lidl.ts`: Update to parse campaign API response shape
- `src/adapters/live/lidlLiveAdapter.test.ts`: Update URL expectations

**Reference**: `nicktcode/swissgroceries-mcp/src/adapters/lidl/client.ts`

#### 1.4 Volgshop — Use WooCommerce REST API

**Why**: `volgshop.ch/de/search` returns 404. Volgshop runs on WooCommerce with a public Store API.

**Pagination**: WooCommerce Store API supports `per_page` and `page` params. Map MCP `limit` to `per_page` (max 100).

**Changes**:
- `src/adapters/live/volgLiveAdapter.ts`: Change to use WooCommerce REST API
  - Base URL: `https://www.volgshop.ch`
  - `searchProducts()`: `/wp-json/wc/store/v1/products?search=X&per_page={limit}`
  - Store search: Not available (delivery-only, return empty with metadata note)
  - Promotions: `/wp-json/wc/store/v1/products?on_sale=true`
- `src/parsers/volg.ts`: Update to parse WooCommerce product response shape
- `src/adapters/live/volgLiveAdapter.test.ts`: Update URL expectations

**Reference**: `nicktcode/swissgroceries-mcp/src/adapters/volgshop/client.ts`

#### 1.5 Otto's — Use OCC v2 API

**Why**: `ottos.ch/de/search` returns HTML. Otto's uses OCC v2 (SAP Commerce) backend.

**Pagination**: OCC v2 supports `pageSize` (max 100) and `currentPage`. Map MCP `limit` to `pageSize` and compute `currentPage` from offset.

**Changes**:
- `src/adapters/live/ottosLiveAdapter.ts`: Change to use OCC v2 API
  - Base URL: `https://api.ottos.ch/occ/v2/ottos`
  - Add iOS Safari User-Agent
  - `searchProducts()`: `/products/search?query=X:relevance&pageSize={limit}&currentPage={page}&fields=FULL`
  - `findStores()`: `/stores?latitude=X&longitude=Y&radius=R&fields=FULL`
- `src/parsers/ottos.ts`: Update to parse OCC v2 response shape
- `src/adapters/live/ottosLiveAdapter.test.ts`: Update URL expectations

**Reference**: `nicktcode/swissgroceries-mcp/src/adapters/ottos/client.ts`

### Phase 2: Test Suite Improvements

#### 2.1 Add `test:integration` npm script for real HTTP tests

**Why**: Live smoke tests hit real APIs and take 30+ seconds each. They slow down the default test run and should be opt-in.

**Changes**:
- `package.json`: Add new script:
  ```json
  "test:integration": "vitest run --passWithNoTests src/**/*.integration.test.ts"
  ```
- `vitest.config.ts`: Add a `include` override or use the script's glob to separate unit from integration
- Keep existing `test:live` script for the `.live.test.ts` files

#### 2.2 Add contract tests as separate `*.contract.test.ts` files

**Why**: The current tests never validate that the adapter's default URLs return JSON. Contract tests fetch real endpoints and verify response shape. Using separate files (not `.live.test.ts`) keeps the test runner output clean and maintains strict boundaries between mocked unit tests, live smoke tests, and contract validation.

**Contract test scope** — each adapter's contract test covers:
1. **Search endpoint**: Fetch with a simple query, verify valid JSON, verify expected fields (`products` array or similar)
2. **Store endpoint**: Fetch with Swiss coordinates (Zurich: 47.3769, 8.5417), verify valid JSON, verify expected fields (`stores` array or similar)
3. **Timeout**: 10-second timeout per request
4. **Env gate**: Gated behind `RUN_CONTRACT_TESTS=1`

**Changes**:
- Create `src/adapters/live/migros.contract.test.ts`
- Create `src/adapters/live/coop.contract.test.ts`
- Create `src/adapters/live/lidl.contract.test.ts`
- Create `src/adapters/live/volg.contract.test.ts`
- Create `src/adapters/live/ottos.contract.test.ts`
- Each file: `describe.skipIf(process.env.RUN_CONTRACT_TESTS !== '1')` with search + store contract tests

#### 2.3 Add `test:contract` npm script

```json
"test:contract": "RUN_CONTRACT_TESTS=1 vitest run --passWithNoTests src/**/*.contract.test.ts"
```

#### 2.4 Fix inconsistent skip pattern in Denner live test

**Why**: Denner's live test uses `describe.skipIf(!process.env.LIVE_SOURCE_TESTS)` while others use `describe.skipIf(process.env.LIVE_SOURCE_TESTS !== '1')`. Standardize.

**Changes**:
- `src/adapters/live/dennerPromotionsAdapter.live.test.ts`: Change to `process.env.LIVE_SOURCE_TESTS !== '1'`

### Phase 3: SPA Improvements

#### 3.1 Show which chains succeeded vs failed

**Why**: Currently the SPA shows warnings but doesn't clearly indicate partial success.

**Changes**:
- `src/web/public/index.html`: Add a summary line showing "X of Y chains returned results" when some fail

## File Change Summary

| File | Action |
|------|--------|
| `package.json` | Add `migros-api-wrapper`, add `test:integration`, `test:contract` scripts |
| `src/adapters/live/migrosLiveAdapter.ts` | Rewrite to use `migros-api-wrapper` with cache/circuit-breaker integration |
| `src/adapters/live/coopLiveAdapter.ts` | Change base URL, add User-Agent, add pagination, DataDome error mapping |
| `src/adapters/live/lidlLiveAdapter.ts` | Change to Lidl Plus API endpoints, document leaflet-only limitation |
| `src/adapters/live/volgLiveAdapter.ts` | Change to WooCommerce REST API, add pagination |
| `src/adapters/live/ottosLiveAdapter.ts` | Change to OCC v2 API endpoints, add pagination |
| `src/parsers/migros.ts` | Update response shape parsing |
| `src/parsers/coop.ts` | Update response shape parsing |
| `src/parsers/lidl.ts` | Update response shape parsing |
| `src/parsers/volg.ts` | Update response shape parsing |
| `src/parsers/ottos.ts` | Update response shape parsing |
| `src/adapters/live/migros.contract.test.ts` | New: contract test for Migros search + store endpoints |
| `src/adapters/live/coop.contract.test.ts` | New: contract test for Coop search + store endpoints |
| `src/adapters/live/lidl.contract.test.ts` | New: contract test for Lidl search + store endpoints |
| `src/adapters/live/volg.contract.test.ts` | New: contract test for Volgshop search endpoint |
| `src/adapters/live/ottos.contract.test.ts` | New: contract test for Otto's search + store endpoints |
| `src/adapters/live/dennerPromotionsAdapter.live.test.ts` | Fix skip pattern consistency |
| `src/web/public/index.html` | Show success/failure summary |

## Execution Order

1. **Migros adapter** — largest change (new dependency + wrapper integration)
2. **Coop adapter** — URL + User-Agent fix
3. **Lidl adapter** — URL fix to Lidl Plus API
4. **Volgshop adapter** — URL fix to WooCommerce API
5. **Otto's adapter** — URL fix to OCC v2 API
6. **Contract tests** — add shared helper + npm scripts
7. **SPA improvements** — success/failure summary
8. **Full test pass** — `pnpm lint && pnpm test && pnpm build`

## Risk Notes

- `migros-api-wrapper` is a third-party package that may change; pin version in package.json
- Migros wrapper does its own HTTP — must manually integrate caching/circuit-breaking (see Phase 1.1)
- Coop's DataDome may block if rate-limited; the iOS User-Agent approach is used by other MCPs but is inherently fragile — support env var override
- Lidl only exposes weekly leaflet (not full catalog) — document in tool metadata so LLMs understand limitations
- Volgshop is delivery-only (no physical store search) — return empty with metadata note
- Otto's is grocery-adjacent (food + drugstore + baby) — filter to relevant categories in parser
- Pagination must be mapped from MCP `limit` param to each API's native pagination (see per-adapter sections)
