# Real Data Infrastructure Test Cases

Date: 2026-05-19
Status: implemented through Aldi live-beta slice

These cases cover the Phase 0/1 real-data migration infrastructure from
`docs/active/REAL_DATA_IMPLEMENTATION_PLAN.md`. They intentionally do not call
live retailer sources; live tests stay opt-in through `npm run test:live`.

## Test Matrix

| Area | Test file | Cases covered |
|---|---|---|
| Provenance/cache metadata | `src/cache/fileTtlCache.test.ts` | Fresh cache hit returns data and `freshness: "cached"`; expired cache is hidden unless stale reads are allowed; stale reads return `freshness: "stale"` |
| Cache safety | `src/cache/fileTtlCache.test.ts` | Non-positive TTL is rejected; cache key mismatch throws instead of returning the wrong payload |
| Source HTTP client | `src/sources/sourceClient.test.ts` | JSON success returns live provenance; text success returns live provenance; user-agent and accept headers are sent; 503 is retried; 429 maps to `SOURCE_RATE_LIMITED`; invalid JSON maps to `SOURCE_PARSE_FAILED`; timeout abort maps to `SOURCE_UNAVAILABLE`; per-host request spacing is enforced |
| Aldi parser fixtures | `src/parsers/aldi.test.ts` | Product sitemap parsing; product JSON-LD parsing for name, brand, price, category, image, availability, and URL; explicit URL fallback; missing product JSON-LD error; invalid price error |
| Aldi fixture-backed adapter | `src/adapters/live/aldiFixtureAdapter.test.ts` | Normalized fixture product mapping, provenance, filters, blank query validation, unsupported store and availability behavior |
| Aldi live-beta adapter | `src/adapters/live/aldiLiveAdapter.test.ts` | Fake-transport live search, cache reuse, stale-cache fallback with `SOURCE_STALE_CACHE_USED`, no-cache source failure, unsupported store and availability behavior |
| Adapter registry | `src/adapters/index.test.ts` | Default runtime wiring uses Aldi live-beta; `legacy-static` mode keeps deterministic static Aldi tests available |
| Source health | `src/services/sourceHealthService.test.ts` | Live observations become `live-beta`; not-implemented warnings become `blocked`; other source warnings become `degraded` |
| Product search warnings | `src/services/searchService.test.ts` | One failed adapter returns successful products plus `sourceWarnings`; all failed adapters return `ALL_SOURCES_FAILED`; metadata from successful adapters is propagated |
| Store search warnings | `src/services/searchService.test.ts` | One failed adapter returns successful stores plus `sourceWarnings`; all failed adapters return `ALL_SOURCES_FAILED` |
| Price comparison warnings | `src/services/priceComparisonService.test.ts` | One failed adapter returns successful offers plus `sourceWarnings`; all failed adapters return `ALL_SOURCES_FAILED`; metadata from successful adapters is propagated |
| MCP structured responses | `src/tools/handlers.test.ts` | `search_products`, `find_stores`, and `compare_prices` include metadata `sourceWarnings` in structured responses |
| Opt-in live smoke | `src/adapters/live/aldiLiveAdapter.live.test.ts` | Skipped unless `LIVE_SOURCE_TESTS=1`; searches live Aldi source for `toskanabrot` and asserts provenance/source status without exact price coupling |

## Commands

Run the deterministic test suite:

```sh
npm test -- --run
```

Run the full quality gate:

```sh
npm run lint
npm test -- --run
npm run build
```

Run opt-in live smoke tests when live tests exist:

```sh
npm run test:live
```

Run live smoke tests against current retailer sources:

```sh
LIVE_SOURCE_TESTS=1 npm run test:live
```

On Windows PowerShell:

```powershell
$env:LIVE_SOURCE_TESTS='1'; npm run test:live; Remove-Item Env:\LIVE_SOURCE_TESTS
```

## Notes

- Test doubles are limited to transport boundaries and adapter failure
  injection.
- No test introduces invented production fallback data.
- Live retailer access is deliberately excluded from default CI so source drift
  does not make deterministic checks flaky.
