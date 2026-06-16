# Vendor Coverage Implementation Plan

## Executive Summary

This plan covers implementing full search, price comparison, and store availability capabilities for the 8 supported Swiss grocery chains. Priority goes to **Migros** and **Coop** (highest user frequency), followed by Aldi and Denner (already partially implemented), then the remaining chains.

## Current State

| Chain | productSearch | promotions | storeSearch | availability | nutrition |
|-------|:---:|:---:|:---:|:---:|:---:|
| Migros | blocked | blocked | source-auditing | unsupported | source-auditing |
| Coop | blocked | blocked | source-auditing | unsupported | unsupported |
| Aldi | **live-beta** | unsupported | unsupported | unsupported | unsupported |
| Denner | unsupported | **live-beta** | unsupported | unsupported | unsupported |
| Lidl | source-auditing | unsupported | source-auditing | unsupported | unsupported |
| Farmy | blocked | blocked | blocked | blocked | blocked |
| Volg | blocked | source-auditing | source-auditing | unsupported | unsupported |
| Otto's | source-auditing | source-auditing | source-auditing | unsupported | unsupported |

**Key finding:** Aldi product search and Denner promotions are the only live-beta capabilities. Migros and Coop are completely blocked despite being the most-used chains.

## Research Findings

### Existing Reference Projects

1. **nicktcode/swissgroceries-mcp** (17 stars) — Full MCP server with all 8 chains
   - Uses unofficial mobile-app endpoints
   - Migros: `migros-api-wrapper` npm package (guest token, no auth needed)
   - Coop: coopathome API endpoints (no auth needed)
   - Denner: Auto-auth JWT (anonymous self-registration)
   - Lidl: Weekly leaflet scraping only
   - Per-store stock via `find_stock` tool
   - Shopping planner with multi-store strategies

2. **lewpgs/migros-mcp** (123 stars) — Migros-focused MCP
   - Product search, nutrition, store search, promotions
   - `get_stock` for per-store availability (daily updates)
   - Uses `migros-api-wrapper` npm package
   - Authenticated basket management (optional)

3. **Denner Shop API** (denner-shop-api-docs.detailnet.ch)
   - RESTful API for Denner wine shop
   - OpenAPI 3.0 documented
   - Wine products with full metadata

### API Access by Chain

| Chain | Product Search API | Store API | Availability API | Source Type |
|-------|-------------------|-----------|------------------|-------------|
| **Migros** | `search-api.migros.ch` + `migros-api-wrapper` | Migros store finder API | `get_stock` (daily) | Unofficial mobile/web endpoints |
| **Coop** | coop.ch search API (DataDome protected) | coop.ch store finder | Unknown | Unofficial web endpoints |
| **Aldi** | aldi-suisse.ch product pages + sitemap | Store finder | Unknown | Web scraping |
| **Denner** | denner.ch wine shop API | denner.ch store finder | Unknown | REST API + web |
| **Lidl** | Weekly leaflet only | lidl.ch store finder | Not available | Web scraping |
| **Farmy** | farmy.ch (ceased operations) | N/A | N/A | Blocked |
| **Volg** | volgshop.ch | volg.ch store finder | Unknown | Web |
| **Otto's** | ottos.ch | ottos.ch store finder | Per-store stockLevel | Web |

## Implementation Phases

### Phase 1: Migros (Priority: CRITICAL)

**Why:** Largest Swiss retailer, most stores, strongest price competition with Coop.

**Capabilities to implement:**
1. **Product Search** — Use `migros-api-wrapper` npm package
   - Anonymous guest token (no auth needed)
   - Full catalog search with prices, nutrition, ratings
   - Category browsing
2. **Store Search** — Migros store finder API
   - Location-based search (ZIP/city/coordinates)
   - Opening hours, services, address
3. **Promotions** — Migros current deals API
   - Weekly promotions with prices
   - Category filtering
4. **Availability** — `get_stock` endpoint
   - Per-store product availability
   - Daily update cadence
5. **Nutrition** — Product detail API
   - Full nutrition facts per 100g/100ml
   - Allergens, ingredients

**Reference:** `lewpgs/migros-mcp` (123 stars) — proven approach using `migros-api-wrapper`

**Implementation:**
- `src/adapters/live/migrosLiveAdapter.ts`
- Uses `migros-api-wrapper` npm package for API calls
- No authentication required for search/browse/stock
- Optional: basket management with Migros credentials

### Phase 2: Coop (Priority: CRITICAL)

**Why:** Second largest, strong online presence (CHF 375M online sales), direct Migros competitor.

**Capabilities to implement:**
1. **Product Search** — coop.ch search API
   - Full catalog (22,000+ products)
   - Same prices as in-store
   - DataDome bot protection handling
2. **Store Search** — coop.ch store finder
   - Location-based search
   - Opening hours, services
3. **Promotions** — coop.ch current promotions
   - Weekly deals
   - Digital coupons
4. **Availability** — Unknown if per-store stock API exists
   - May need to investigate coop.ch availability endpoints
5. **Nutrition** — Product detail API
   - Nutrition facts from product pages

**Challenge:** DataDome bot protection requires User-Agent rotation or session management.

**Implementation:**
- `src/adapters/live/coopLiveAdapter.ts`
- Custom HTTP client with DataDome handling
- Session management for bot protection bypass

### Phase 3: Aldi Enhancement (Priority: HIGH)

**Why:** Already has live-beta product search. Need to complete the capability set.

**Capabilities to add:**
1. **Promotions** — Weekly Aktionsware specials
   - Aldi weekly flyer/promotions pages
   - Limited-time offers
2. **Store Search** — Aldi store finder
   - Location-based search
   - Opening hours
3. **Availability** — Investigate if per-store stock exists
   - Likely not available (Aldi model is limited assortment)
4. **Nutrition** — Product detail pages
   - Allergen claims (limited in API)

**Reference:** Existing `aldiLiveAdapter.ts` — extend with promotions and stores

### Phase 4: Denner Enhancement (Priority: HIGH)

**Why:** Already has live-beta promotions. Need product search and stores.

**Capabilities to add:**
1. **Product Search** — Denner wine shop API
   - Full wine catalog via REST API
   - OpenAPI 3.0 documented at denner-shop-api-docs.detailnet.ch
   - Wine products with vintage, ratings, pricing
2. **Store Search** — Denner store finder
   - Location-based search
   - Opening hours
3. **Availability** — Unknown if per-store stock exists
   - Denner is primarily in-store focused

**Reference:** Existing `dennerPromotionsAdapter.ts` — extend with product search

### Phase 5: Lidl (Priority: MEDIUM)

**Why:** Weekly flyer model limits capabilities, but still useful for deal comparison.

**Capabilities to implement:**
1. **Product Search** — Weekly leaflet scraping
   - Current week's products only
   - Limited catalog
2. **Promotions** — Weekly deals
   - Flyer-based promotions
3. **Store Search** — lidl.ch store finder
   - Location-based search

**Limitation:** Lidl does not offer online grocery delivery in Switzerland. Product data is limited to weekly campaigns.

### Phase 6: Otto's (Priority: MEDIUM)

**Why:** Grocery-adjacent with food, drugstore, and baby products.

**Capabilities to implement:**
1. **Product Search** — ottos.ch category/product pages
   - Food, drugstore, baby products
   - `priceLabels` facet for pricing
2. **Promotions** — Current deals
3. **Store Search** — ottos.ch store finder
4. **Availability** — Per-store `stockLevel`
   - Otto's has per-store stock data

### Phase 7: Volg (Priority: LOW)

**Why:** Regional supermarket, limited online presence.

**Capabilities to implement:**
1. **Product Search** — volgshop.ch catalog
2. **Promotions** — `on_sale` filter
3. **Store Search** — volg.ch store finder

**Limitation:** Volgshop delivers to 1,100+ rural municipalities but not city centers.

### Phase 8: Farmy (Priority: SKIP)

**Status:** Operations have ceased. All capabilities blocked.

## Technical Architecture

### Adapter Pattern

Each live adapter follows the established pattern:

```typescript
// src/adapters/live/<chain>LiveAdapter.ts
export class <Chain>LiveAdapter implements ChainAdapter {
  chain: Chain;
  capabilities: SourceCapability[];

  async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> { ... }
  async searchStores(filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> { ... }
  async getPromotions(filters: PromotionFilters): Promise<Result<NormalizedPromotion[]>> { ... }
  async lookupStoreProductAvailability(storeId: string, query: string): Promise<Result<...>> { ... }
}
```

### Shared Infrastructure

- `src/sources/sourceClient.ts` — HTTP client with rate limiting, retry, circuit breaker
- `src/cache/fileTtlCache.ts` — File-based TTL cache for API responses
- `src/services/searchService.ts` — Multi-chain fan-out search
- `src/services/priceComparisonService.ts` — Cross-chain price comparison

### Testing Strategy

- **Unit tests:** Adapter-specific parser and normalization tests
- **Integration tests:** MCP tool tests via loopback transport
- **Live smoke tests:** Opt-in `RUN_LIVE=1` for real API validation
- **Fixture tests:** Snapshot tests with captured API responses

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| API endpoints change without notice | High | Version-pinned adapters, fixture tests, monitoring |
| Bot protection blocks requests | Medium | User-Agent rotation, session management, rate limiting |
| Rate limiting from chains | Medium | Per-host rate limits, caching, exponential backoff |
| Data accuracy concerns | Medium | Source provenance tracking, freshness indicators |
| Legal/TOS concerns | Low | Unofficial endpoints, disclaimers, reasonable request rates |

## Success Metrics

1. **Migros + Coop:** Full product search, store search, promotions, and availability working
2. **Cross-chain comparison:** Prices comparable across Migros, Coop, Aldi, Denner
3. **Test coverage:** 90%+ adapter test coverage
4. **Build stability:** `pnpm lint && pnpm test && pnpm build` passes consistently
5. **Source status:** All chains have accurate capability status in registry

## Timeline Estimate

| Phase | Chain | Estimated Effort | Dependencies |
|-------|-------|-----------------|--------------|
| Phase 1 | Migros | 3-5 days | `migros-api-wrapper` integration |
| Phase 2 | Coop | 3-5 days | DataDome handling |
| Phase 3 | Aldi Enhancement | 2-3 days | Existing adapter extension |
| Phase 4 | Denner Enhancement | 2-3 days | Existing adapter extension |
| Phase 5 | Lidl | 1-2 days | Leaflet scraping |
| Phase 6 | Otto's | 1-2 days | Web scraping |
| Phase 7 | Volg | 1 day | Web scraping |
| **Total** | | **13-22 days** | |

## Recommended Approach

1. **Start with Migros** — Use `migros-api-wrapper` as proven by `lewpgs/migros-mcp`
2. **Parallel Coop work** — Investigate coop.ch API endpoints and DataDome handling
3. **Extend Aldi** — Add promotions and store search to existing adapter
4. **Extend Denner** — Add product search via wine shop API
5. **Batch remaining chains** — Lidl, Otto's, Volg in quick succession

## Open Questions

1. Does Coop have a per-store availability API? (Need to investigate)
2. Is Migros `get_stock` reliable enough for real-time availability?
3. Should we support authenticated Migros basket management?
4. How to handle DataDome bot protection for Coop requests?
5. Should we add geocoding service for location-based searches?

---

## Gemini 3.1 Pro Preview Review (2026-06-16)

### Verdict: 90% ready — address geocoding and cross-chain matching gaps

### Technical Feasibility

| Phase | Feasibility | Notes |
|-------|-------------|-------|
| Migros | **High** | `migros-api-wrapper` proven approach, anonymous guest token |
| Coop | **Moderate/Low** | DataDome is significant; investigate mobile app API endpoints |
| Aldi/Denner | **High** | Incremental updates to existing adapters |
| Lidl/Otto's/Volg | **Moderate** | Web scraping is brittle; Otto's `stockLevel` is valuable |

### Key Recommendations

1. **Add Phase 0: Shared Utilities** — Implement geocoding and cross-chain product matching before Coop
2. **Move Otto's up** — Explicit `stockLevel` data is higher value than Lidl weekly leaflet
3. **Parallelize Coop investigation** — Don't wait for Migros; test DataDome limits early
4. **Investigate Coop mobile API** — Mobile endpoints often bypass DataDome with static API keys

### Missing Considerations Addressed

- **Geocoding:** Add `src/util/geo.ts` using OpenStreetMap Nominatim or Swiss ZIP-to-coord mapping
- **Cross-chain matching:** Implement `matchService` with Jaro-Winkler similarity on name + brand + weight
- **Multi-language:** Pass `language` preference to adapters (default: 'de')
- **Health monitoring:** `SourceHealthService` tracking success/failure rates per adapter
- **Dependency management:** Add `migros-api-wrapper` to `package.json`
- **Data consistency:** Strict `NormalizedPrice.unit` enforcement across all adapters

### Risk Additions

- **Adapter maintenance decay:** With 8 chains, one parser breaks monthly on average
- **Legal/TOS:** High-volume scraping could trigger IP blocks
- **Unit conversion errors:** Must enforce consistent unit basis for price comparisons
