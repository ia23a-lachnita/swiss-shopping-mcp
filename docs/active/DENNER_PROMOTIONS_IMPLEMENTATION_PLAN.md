# Denner Promotions Implementation Plan

Date: 2026-05-19
Status: implemented; post-implementation Gemini follow-up found no blockers

## Goal

Add a minimal complete Denner promotions engine and make price comparison
optionally promotion-aware without weakening the current source-honesty model.

This slice should unlock one new real-source capability:

- parse Denner current actions from public retailer pages
- expose normalized promotion data with provenance and warnings
- allow `compare_prices` to rank by effective promotional price when explicitly
  requested

## Non-goals

- Do not implement Denner full-catalog product search.
- Do not scrape account, cart, checkout, shopping-list, or auth paths.
- Do not silently mix static and live data without labeling the source.
- Do not add mobile, Firebase, account, or shopping-cart MCP tooling.

## Source Path

Primary source:

- `https://www.denner.ch/de/aktionen/aktuelle-aktionen`

Source policy:

- Treat Denner as `retailer-web`.
- Use conservative HTTP behavior through `SourceHttpClient`.
- Cache successful parses through `FileTtlCache`.
- Use stale cache only with `SOURCE_STALE_CACHE_USED`.
- Return explicit source warnings when live and cache data are unavailable.

## Domain Model Changes

Extend `NormalizedPromotion` so a promotion can stand alone as a price offer:

- `productName?: string`
- `brand?: string`
- `category?: string`
- `description?: string`
- `image?: string`
- `price?: NormalizedPrice`
- `originalPrice?: number`
- `unit?: { value: number; per: string }` through `price.unit`
- existing `discount`, validity, stores, and provenance stay supported

Add filters:

- `PromotionSearchFilters`
  - `query`
  - `chains`
  - `matchMode`
  - `category`
  - `limit`

Add adapter capability:

- `searchPromotions(filters): Promise<Result<NormalizedPromotion[]>>`

Static adapters can return an empty list. Live adapters that cannot provide
promotions return an explicit not-implemented source warning/error when called.

## Parser

Add `src/parsers/denner.ts` with:

- `parseDennerPromotionsPage(html, sourceUrl)`
- inspect the current page for embedded JSON/API-backed data before settling
  on HTML card parsing
- robust extraction from embedded JSON or HTML card markup
- validation for required fields:
  - stable id or URL-derived id
  - title or product name
  - current promotional price
  - validity window when present
- clear parse errors for missing required fields
- filter out expired promotions in the adapter before returning results

Fixture coverage:

- `fixtures/live-sources/denner/current-actions.sample.html`
- parser test for normal promotion cards
- parser test for malformed/empty pages

## Adapter

Add `src/adapters/live/dennerPromotionsAdapter.ts`.

Responsibilities:

- use a decorator pattern around the existing static Denner adapter so product
  and store behavior stays backward compatible
- implement `searchPromotions`
- cache Denner actions page
- attach promotion provenance
- return source status:
  - `live-beta` for fresh live data
  - `degraded` for stale cache
  - explicit source warning for failures

Default runtime:

- In `live-beta` mode, replace Denner static adapter with the Denner promotions
  adapter.
- In `legacy-static` mode, keep the existing static adapter only.

## Tool Surface

Add an MCP tool:

- `search_promotions`

Inputs:

- `query`
- `chains`
- `category`
- `limit`
- `matchMode`

Output:

- `{ promotions, sourceWarnings?, sources?, summary? }`

This makes Denner promotion ingestion visible independently of
`compare_prices`.

## Promotion-Aware Comparison

Add `includePromotions?: boolean` to `compare_prices`.

Behavior:

- Default remains `false` for compatibility.
- When `true`, compare service queries matching promotions from adapters.
- Matching promotions become offers with:
  - `promotion?: NormalizedPromotion`
  - `effectivePrice`
  - `priceBasis: "product" | "promotion"`
  - explanation/warning metadata when an offer came from a promotion source
- Sorting uses promotional effective price for pack-price comparisons.
- Unit-price comparison may use promotion unit data only when normalized unit
  data is present; otherwise it remains ineligible with a clear reason.
- Existing static product offers remain visible unless promotion ranking places
  a promotion ahead of them.
- Deduplicate identical chain/product-name offers by keeping the promotion
  offer when its effective price is lower than the static product offer.

Edge cases:

- If a promotion source fails but product sources succeed, return product
  comparison plus source warnings.
- If only promotions match, return promotion offers rather than all-fail.
- If no products or promotions match, return an empty successful comparison.
- Expired promotions are not eligible for comparison.

## Tests

Add or update tests for:

- Denner parser normal path and malformed path
- Denner promotion adapter live/cache/stale/failure behavior
- `search_promotions` validation and structured output
- `compare_prices` default compatibility with promotions disabled
- promotion-aware comparison ranking by effective promotional price
- unit-price comparison ineligible path when promotion unit data is missing

## Verification

Run:

```powershell
npm run lint
npm test -- --run
npm run build
```

Optional live smoke can be added later once the fixture-backed parser is stable.

## Tracker Updates

Update `docs/active/IMPLEMENTATION_TRACKER.md` after:

1. Plan is Gemini-reviewed. Completed 2026-05-19; no architectural blockers,
   with implementation cautions added for source inspection, deduplication,
   validity filtering, and static-adapter decoration.
2. Denner parser/adapter/tool/comparison implementation is complete.
3. Verification passes.
