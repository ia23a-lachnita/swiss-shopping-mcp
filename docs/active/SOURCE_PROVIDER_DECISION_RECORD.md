# Source Provider Decision Record

Date: 2026-06-16
Status: proposed

## Decision Needed

Product search cannot depend on invented static data or synchronous local crawling.
Choose the production data strategy before expanding chain coverage.

## Options

| Option | Pros | Cons | Decision |
|---|---|---|---|
| Official/partner APIs | Strongest compliance and stability | May not exist or require partnership | Prefer when available |
| Paid normalized provider | Fastest path to real prices/catalogs | Cost, dependency, contract review | Evaluate Pepesto first |
| Maintained backend index | Control and transparency | Requires crawler jobs, storage, monitoring, legal review | Use only after source approval |
| Local runtime crawling | Simple prototype | Cold-cache latency, rate limits, robots/terms risk, poor recall | Reject for broad product search |

## Open Data Role

Open Food Facts, Open Prices, and FoodRepo can enrich product metadata and price
observations, but cannot be treated as complete retailer truth unless coverage
and freshness are measured per chain.

## External Verification Checklist

- Pepesto: confirm Swiss chain list, exact endpoint docs, pricing, license,
  rate limits, freshness SLA, redistribution rights, and whether store-level
  availability exists.
- swissgroceries-mcp: inspect endpoints, terms posture, source freshness,
  error handling, and whether it can be used as reference only.
- migros-mcp and migros-api-wrapper: inspect Migros endpoint behavior, guest
  token flow, breakage history, and legal risk.
- Open Food Facts/Open Prices/FoodRepo: measure Swiss chain coverage, EAN match
  rate, last-updated timestamps, and license compatibility.

## Current Source Status Per Chain

| Chain | Product Search | Promotions | Store Search | Availability |
|---|---|---|---|---|
| Aldi | live-beta (constrained sitemap) | unsupported | unsupported | unsupported |
| Denner | unsupported | live-beta | unsupported | unsupported |
| Migros | blocked — needs provider/index decision | blocked | source-auditing | unsupported |
| Coop | blocked — search endpoints unsuitable | blocked | source-auditing | unsupported |
| Lidl | source-auditing | unsupported | source-auditing | unsupported |
| Farmy | blocked — operations ceased | blocked | blocked | blocked |
| Volg | blocked — no catalog source | source-auditing | source-auditing | unsupported |
| Otto's | source-auditing | source-auditing | source-auditing | unsupported |

## Decision Log

- 2026-06-16: Local runtime crawling rejected for broad product search. Aldi live-beta
  constrained sitemap path remains as the only approved runtime crawl, pending rate-limit
  and recall measurement. All other chains are blocked or unsupported until a provider or
  maintained index is selected.
