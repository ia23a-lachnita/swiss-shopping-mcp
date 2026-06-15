# Aldi Live-Beta Adapter Slice

Date: 2026-05-19
Status: implemented and verified
Last updated: 2026-06-16

## Scope Decision (2026-06-16)

Aldi product search remains live-beta with the following constraints:

- **Query recall is URL-term based**: the adapter matches normalized query tokens
  against product URLs in the sitemap, not a full-text product catalog index.
  Broad queries ("food", "products") return empty or misleading results.
- **Not a broad catalog search**: this is URL-keyword lookup, not semantic search.
  Callers expecting full Aldi product catalog coverage must wait for a provider/index
  decision (see `docs/active/SOURCE_PROVIDER_DECISION_RECORD.md`).
- **Cold-cache latency**: first request fetches sitemap (large XML) + product pages
  in serial with 1-second rate-limit gaps. Cached results are served within budget.
- **Rate-limit behavior**: 1-second inter-request delay per host. No retry on 429.
- **Unit price/size**: parsed from product pages where present. Missing unit info
  marks the offer as ineligible for unit-price comparison.
- **Source warnings on partial page failures**: parse failures per page are surfaced
  as `SOURCE_PARSE_FAILED` warnings, not silently dropped.

Aldi remains enabled because the above constraints are documented and source warnings
are returned on failure. It will be replaced or supplemented if a provider/index
decision is made.

## Original Scope

This slice turns the Aldi fixture-backed parser path into a runtime live-beta
product search adapter.

- `src/adapters/live/aldiLiveAdapter.ts` fetches Aldi product sitemap and
  product pages through `SourceHttpClient.fetchText`.
- Parsed sitemap entries and product observations are stored in `FileTtlCache`.
- Runtime product results include Aldi `retailer-web` provenance.
- Stale cache use is explicit through `SOURCE_STALE_CACHE_USED`; source fetch or
  parse failures are not hidden behind static Aldi fallback data.
- `createDefaultAdapters()` uses the Aldi live-beta adapter by default; other
  chains use `UnsupportedChainAdapter` until their own source work is complete.

## Source Path

| Source | URL |
|---|---|
| Product sitemap | `https://www.aldi-suisse.ch/de/sitemap_products.xml` |
| Example product page | `https://www.aldi-suisse.ch/de/produkt/backbox-toskanabrot-000000000000101698` |

The adapter selects product-page candidates from the sitemap by matching
normalized query terms against product URLs. It then parses selected product
pages and applies the shared product matcher and filters.

## Runtime Behavior

| Capability | Status | Notes |
|---|---|---|
| Aldi product search | live-beta | Uses live source when available; fresh and stale cache are labeled |
| Aldi product cache | done | File TTL cache stores parsed sitemap entries and parsed product observations |
| Source warnings | done | Live failures and stale cache use are returned in metadata |
| Store search | not implemented | Returns `REAL_SOURCE_NOT_IMPLEMENTED` |
| Store availability | not implemented | Returns unsupported availability metadata |
| Deterministic test mode | done | `createDefaultAdapters({ dataMode: "legacy-static" })` keeps old static behavior for unit/integration tests |

## Test Cases

| Test file | Coverage |
|---|---|
| `src/adapters/live/aldiLiveAdapter.test.ts` | Live-source happy path through fake transport, cache reuse, stale-cache fallback warnings, no-cache source failure, unsupported store/availability behavior |
| `src/adapters/live/aldiLiveAdapter.live.test.ts` | Opt-in live smoke test for `toskanabrot`, skipped unless `LIVE_SOURCE_TESTS=1` |
| `src/adapters/index.test.ts` | Default Aldi live-beta wiring and deterministic legacy-static mode |
| `src/services/searchService.test.ts` | Successful-adapter metadata propagation |
| `src/services/priceComparisonService.test.ts` | Successful-adapter metadata propagation into comparison responses |
| `src/sources/sourceClient.test.ts` | Text fetching, request headers, and live provenance |

## Commands

Deterministic quality gate:

```sh
npm run lint
npm test -- --run
npm run build
```

Opt-in live smoke:

```sh
LIVE_SOURCE_TESTS=1 npm run test:live
```

On Windows PowerShell:

```powershell
$env:LIVE_SOURCE_TESTS='1'; npm run test:live; Remove-Item Env:\LIVE_SOURCE_TESTS
```
