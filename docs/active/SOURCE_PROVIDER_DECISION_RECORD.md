# Source Provider Decision Record

Date: 2026-06-16
Status: superseded 2026-07-24 (see "2026-07-24 update" at the end) — accepted provisionally, not closed

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

## 2026-07-24 update: local crawling + resilience infrastructure, accepted provisionally

**What actually happened:** the team proceeded with local runtime crawling for every
chain anyway — Playwright-based per-chain adapters bypassing Cloudflare (Migros) and
DataDome (Coop) — but paired it with four phases of resilience infrastructure built
after this record: (A) tiered cache freshness policy with stale-fallback and LRU
eviction; (B) circuit breakers + daily budgets across a 6-provider web-search failover
chain, with vendor-strength-aware skip logic; (C) a SQLite FTS5 product catalog with
query normalization, synonym expansion, and lifecycle tracking
(active/suspected_removed/removed via consecutive-failure counters); (D) per-result
provenance/confidence scoring and observation validation that rejects implausible
price swings (>75% drop, >100% rise) as `pending_verification` rather than trusting
them outright. No paid provider or maintained index (Pepesto etc.) was ever engaged
further — this path superseded that evaluation by outperforming it in practice.

**Current state:** all 7 active chains (Migros, Coop, Aldi, Lidl, Otto's, Volg, Denner)
are `live-beta` and pass live smoke tests against real endpoints as of today
(2026-07-24). The rate-limit/recall/legal risks this record originally worried about
have not materialized as blockers in ~2 months of live operation.

**Decision:** accept the local-crawling-plus-resilience-infrastructure architecture as
the *current operational pattern* — **provisionally, not as a permanently closed
question**. Reviewed with a second AI opinion (antigravity-mcp, gemini-3.6-flash),
which flagged three specific risks this record should stay honest about rather than
declare solved:

1. **Anti-bot maintenance trap** — passing smoke tests today is not the same as
   surviving DataDome/Cloudflare fingerprint changes at scale; Playwright bypasses are
   an ongoing cat-and-mouse game across 7 adapters, not a one-time fix.
2. **Legal/compliance exposure** — commercial scraping in Switzerland can implicate
   UWG Art. 5 (unfair competition) or database-rights protections; a single
   cease-and-desist from a major chain could break ingestion for that chain with no
   official fallback in place today.
3. **Silent degradation** — Phase D's observation validation catches implausible price
   swings and hard failures, but a DOM/API shape change could still silently
   misparse pack sizes, multi-buy pricing, or promotions before any counter trips.

**Concrete re-evaluation triggers** (revisit a paid provider/maintained index if any
of these occur, rather than waiting for a scheduled review):

- Adapter-breakage maintenance load exceeds a noticeable, recurring share of
  engineering time in a given month (DOM/selector/captcha fixes, not new features).
- Unhandled adapter error rate exceeds a small single-digit percentage sustained over
  a rolling 7-day window for any chain.
- A formal legal/ToS notice is received from any chain.
- A chain fully blocks the current Playwright-based bypass with no viable workaround.

Until one of these fires, no further action is needed — this is a documentation update
confirming the working architecture, not a code change.
