# Production Readiness Audit

Date: 2026-06-15
Status: audit complete
Reviewer: Codex, with Gemini second-pass review requested using `gemini-3.1-pro-preview`

## Verdict

This project is not production-ready.

The primary blocker is data trust. A shopping MCP server is useful only if its
product, price, promotion, store, and availability responses are real enough to
act on. The current runtime still returns invented static products and stores
for most chains. That makes it a prototype/test harness, not a production
shopping tool.

The static product search concern is valid and severe. Static search can make an
LLM confidently recommend products, prices, and store options that are stale,
partial, or fictional. For this project, static runtime data should be treated
as test data only.

## Scope Reviewed

- `src/index.ts`
- `src/tools/handlers.ts`
- `src/adapters/index.ts`
- `src/adapters/staticCatalog.ts`
- `src/adapters/staticChainAdapter.ts`
- `src/adapters/live/aldiLiveAdapter.ts`
- `src/adapters/live/dennerPromotionsAdapter.ts`
- `src/services/searchService.ts`
- `src/services/priceComparisonService.ts`
- `src/parsers/aldi.ts`
- `src/parsers/denner.ts`
- `src/sources/sourceClient.ts`
- `src/cache/fileTtlCache.ts`
- `README.md`
- `package.json`
- `docs/active/IMPLEMENTATION_TRACKER.md`
- `docs/active/SOURCE_AUDIT.md`
- `docs/active/REAL_DATA_IMPLEMENTATION_PLAN.md`
- `docs/active/ALDI_LIVE_BETA_ADAPTER.md`
- `docs/active/MCP_TEST_REPORT.md`

## Critical Blockers

### 1. Production runtime still depends on static catalog data

`createDefaultAdapters()` defaults to `live-beta`, but still imports
`STATIC_CHAIN_CATALOG` and returns `StaticChainAdapter` for unsolved chains. In
practice:

- Aldi product search is live-beta.
- Denner promotions are live-beta.
- Denner product search delegates to a static Denner catalog.
- Migros, Coop, Lidl, Farmy, Volg, and Otto's product/store paths remain static.

That means `search_products`, `find_stores`, `compare_prices`, and availability
features can return invented runtime data. This violates the real-data migration
plan, which says unsolved chains should return explicit source warnings rather
than static fallback data.

Production requirement:

- Remove `staticCatalog.ts` from production adapter creation.
- Keep static data only in tests and local demos.
- Return `REAL_SOURCE_NOT_IMPLEMENTED`, `SOURCE_TERMS_BLOCKED`, or other source
  warnings for chains without a real source.

### 2. Static search creates false confidence

The static catalog is tiny: roughly two products and one store per chain. Search
results therefore look structured and authoritative while representing almost
none of the real retailer inventory.

This is worse than an obvious failure. An MCP client may treat structured
responses as reliable facts. A user could receive a recommendation to buy a
product at a price that was never observed from the retailer.

Production requirement:

- Do not return invented product, price, store, promotion, or availability data
  from production tools.
- If no live source is available, fail honestly with source status metadata.

### 3. Live product search is architecturally unresolved

The source audit shows that major retailer search endpoints are blocked or
unsuitable:

- Migros blocks query and promotion paths.
- Coop blocks search and ajax paths and has a crawl delay.
- Lidl blocks search URLs.
- Otto's blocks API and search paths and has a crawl-delay concern.
- Farmy is blocked because the business has ceased operations.

The current Aldi live-beta implementation searches by matching query tokens
against sitemap URLs, then fetching a capped number of product pages. This is a
useful experiment, but it is not a reliable product search architecture.

Gemini's review sharpened this point: a local MCP server cannot reasonably act
as a crawler for large retailer catalogs during an LLM tool call. Cold caches,
large sitemaps, crawl delays, retailer rate limits, and LLM tool timeouts make
that approach unsuitable as the general production plan.

Production requirement:

- Choose a realistic data architecture:
  - a permitted official/partner API,
  - an approved third-party provider,
  - a centralized backend that crawls/indexes asynchronously within legal and
    rate-limit constraints,
  - or a narrower MCP scope limited to data that can be fetched quickly and
    safely at runtime.

### 4. Aldi live-beta search is incomplete

The Aldi adapter is a good proof of infrastructure, but not production search:

- Candidate discovery depends on query terms appearing in product URLs.
- It fetches only a capped number of product pages.
- It does not build or query a complete indexed catalog.
- Normalized products lack unit prices, allergens, nutrition, rich categories,
  and robust taxonomy.
- Store lookup, promotions, and store-level availability are not implemented.

Production requirement:

- Define clear `live-beta` vs `live-stable` acceptance criteria.
- Do not present Aldi as production-ready until recall, freshness, metadata, and
  operational behavior are proven.

### 5. Store search is mostly static or missing

`find_stores` currently returns static store fixtures for most chains. Aldi
live-beta returns `REAL_SOURCE_NOT_IMPLEMENTED` for store lookup. The static
stores contain one hand-authored location per chain and no source provenance.

The tracker already lists richer geospatial filtering as a next task, which
confirms the current store search is foundational only.

Production requirement:

- Add real store locator sources per chain.
- Add coordinate/radius inputs and distance-ranked results.
- Attach provenance and freshness to store results.
- Do not use one-store fixtures in production runtime.

### 6. Store availability is not real

Availability is supported only through static Migros `storeInventory`, and that
inventory contains a hand-authored product list. All other chains report
unsupported availability.

This should not be marketed as real store-level availability.

Production requirement:

- Treat availability as unsupported unless a real store-specific source exists.
- Use statuses such as `available`, `unavailable`, `limited`, and `unknown`
  only when backed by source evidence.
- Include observation time and source confidence.

## Major Product Gaps

### README overstates the implemented product

The README describes an "advanced" MCP server with smart planning, nutrition
filtering, allergen and dietary support, store locator, promotion tracking, and
optional account integration.

Actual state:

- Smart planning services are not implemented.
- Nutrition data is not meaningfully available across runtime adapters.
- Allergen/dietary filters work only where data exists, mainly static fixtures.
- Promotion search is live-beta only for Denner.
- Account/cart integration is roadmap only.
- Store locator behavior is mostly static.

Production requirement:

- Rewrite README feature claims around current, source-backed behavior.
- Move aspirational V2/V3 items into a roadmap section clearly marked as not
  implemented.

### Price comparison can be mathematically structured but data-poor

The comparison service has useful ranking logic, including unit price support
and promotion inclusion. The problem is upstream data quality. Unit prices,
pack sizes, and current prices are incomplete for live Aldi and static/fake for
most other chains.

Production requirement:

- Do not treat comparison output as production-grade until source-backed prices
  and comparable units are available for the relevant chains.

### Supported chain list is misleading

The domain model lists eight chains, but the real source status is mixed:

- Aldi: product search live-beta only.
- Denner: promotions live-beta, product search static.
- Migros: HTTP adapter exists but is not wired into default runtime and source
  audit marks search blocked.
- Coop: search blocked by audit.
- Lidl: possible catalog candidate but not implemented.
- Farmy: blocked.
- Volg: product data blocked, store audit possible.
- Otto's: source-auditing with high caution.

Production requirement:

- Add a source status tool or response metadata that makes this visible to MCP
  clients.
- Consider hiding unsupported chains by default unless explicitly requested.

## Engineering And Operability Gaps

### No CI quality gate

There is no GitHub Actions workflow in `.github/workflows`. The tracker records
local quality gates, but production readiness needs automated checks on pull
requests and releases.

Production requirement:

- Add CI for lint, tests, build, and optionally coverage.
- Add an opt-in scheduled live smoke job only where source access is approved.

### Tooling docs conflict

The README recommends `pnpm`, while the tracker says `pnpm` is broken under the
current Node/corepack combination and to use `npm run` for scripts.

Production requirement:

- Pick one supported package workflow.
- Update README, tracker, and agent instructions to match.

### Package metadata is unfinished

`package.json` still uses `"author": "Your Name"`. The package is not ready for
public publishing or user trust review.

Production requirement:

- Add real package metadata, repository URL, issue URL, files policy, and
  publish/release instructions.

### Runtime cache defaults are not production policy

The live adapters default to a file TTL cache in the OS temp directory. That is
fine for experimentation, but not a production data policy.

Risks:

- Cache loss between runs.
- No explicit cache sizing or cleanup.
- No corruption recovery beyond JSON parse failure surfacing.
- No lock strategy for concurrent processes.
- No user-visible cache/source status command.

Production requirement:

- Define cache location, TTLs, invalidation, cleanup, corruption handling, and
  source-status visibility.

### HTML parsers are fragile

The Aldi parser depends on JSON-LD blocks, which is reasonable but still source
fragile. The Denner parser uses regex over HTML structure and class names. Both
need drift monitoring.

Production requirement:

- Keep fixture tests.
- Add live smoke tests for approved sources.
- Add parser drift alerts or at least explicit source-health statuses.

### Error and warning behavior is partially good but not complete

The project already has structured source warnings and partial failure handling.
That is a strong foundation.

The missing piece is runtime honesty for unsolved chains. Static fallback data
prevents warnings from surfacing for many chains that should be reported as
blocked or not implemented.

## Test Coverage Assessment

The test suite is useful for deterministic behavior, but it does not prove
production readiness.

What tests currently prove:

- Tool schemas validate input.
- Static adapters filter and sort consistently.
- Services handle partial adapter failures.
- Aldi and Denner live-beta paths work against fixtures/fake transports.
- A narrow Aldi live smoke test exists.

What tests do not prove:

- Real product search recall across chains.
- Real price freshness.
- Real store availability.
- Production adapter creation without static catalog.
- CI repeatability.
- Legal/terms compliance.
- Live source stability over time.

Production requirement:

- Add a guard test that default production adapter creation does not import or
  instantiate static catalog data.
- Add source status tests for every supported chain.
- Add live smoke tests only for approved source paths.

## Gemini Review Notes

Gemini agreed that static product search is a production blocker and highlighted
a broader architectural risk:

- Static catalog data is incompatible with a production shopping MCP because it
  can feed an LLM fabricated or stale shopping facts.
- A local MCP server cannot reliably satisfy `search_products(query)` by
  crawling large retailer sitemaps and product pages during a tool call.
- File TTL caching helps only after warm-up and does not solve cold-cache
  latency, rate limits, or source access restrictions.
- Denner promotions are a better live-runtime proof point than broad product
  catalog crawling because they can be fetched from a small public page.
- Store search may be a better next real-data target than product search because
  store datasets are smaller and change less often.

The main correction from Gemini is that the current real-data plan should be
more explicit about the need for a backend/index/provider, or a narrower runtime
scope, before claiming live multi-chain product search is feasible.

## Recommended Priority Order

1. Stop production runtime from returning static product/store/availability
   data.
2. Add a source-status tool that reports live, blocked, static/test-only, and
   not-implemented states per chain and capability.
3. Rewrite README to distinguish implemented source-backed behavior from
   roadmap claims.
4. Decide the real product-search architecture: official APIs, approved provider,
   centralized index, or narrower MCP scope.
5. Promote Denner promotions as the first realistic live runtime surface, then
   add more promotion/store sources where fetches are small and permitted.
6. Build real store search before claiming broad product discovery.
7. Add CI and production guard tests.
8. Define cache, source health, telemetry, and live smoke policies.
9. Revisit chain support list and remove or hide blocked chains.

## Minimum Bar For Production

This project should not be called production-ready until all of the following
are true:

- Default runtime never imports or returns invented static catalog data.
- Every tool response is either source-backed or explicitly warns that the
  source is not implemented/blocked.
- README claims match implemented behavior.
- CI runs lint, tests, and build.
- At least one capability has a stable live source with provenance, cache policy,
  source warnings, and live smoke coverage.
- Product search architecture is feasible under legal, rate-limit, latency, and
  MCP tool-timeout constraints.
- Store and availability features are not presented as real unless backed by
  real sources.

