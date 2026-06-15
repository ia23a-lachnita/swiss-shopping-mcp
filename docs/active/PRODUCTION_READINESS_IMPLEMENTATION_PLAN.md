# Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove non-production runtime behavior and build a near-production Swiss shopping MCP where every response is source-backed or explicitly unsupported.

**Architecture:** Default runtime becomes source-status-first: live adapters return observed data with provenance, unsupported adapters return explicit source warnings, and no static/demo catalog exists in runtime. Product search is treated as an architecture decision, not a scraping exercise: use approved APIs/providers or a maintained index; keep local runtime fetches only for small, permitted sources such as Denner promotions and store locators.

**Tech Stack:** TypeScript strict mode, MCP SDK, Zod, Vitest, ESLint, `SourceHttpClient`, `FileTtlCache`, source provenance/warning domain types.

---

## Non-Negotiable Product Rules

1. Default runtime must not import `staticCatalog.ts`, instantiate `StaticChainAdapter`, or return invented product/store/availability data.
2. No fallback may fabricate data when a live source fails. Failure returns explicit metadata or an MCP error.
3. Tests may use fixtures, fake HTTP transports, and test-only adapter doubles, but only to verify production behavior at boundaries.
4. Demo behavior must exercise the same production code paths as runtime; no separate fake catalog demo mode.
5. A chain/capability is supported only when a real source is implemented, tested, documented, and visible in source status.

## Research Summary

The web research confirms that the hard part is data source architecture, not TypeScript mechanics.

| Candidate | What It Solves | Production Caution | Link |
|---|---|---|---|
| `nicktcode/swissgroceries-mcp` | Similar Swiss grocery MCP with multi-chain claims and public/mobile endpoint approach | README explicitly says it is unofficial and APIs may change any time; useful as research, not proof of production stability | [GitHub](https://github.com/nicktcode/swissgroceries-mcp) |
| `lewpgs/migros-mcp` | Migros-specific MCP for product search, nutrition, stores, promotions | Migros-only; inspect implementation before reuse; still likely unofficial | [GitHub](https://github.com/lewpgs/migros-mcp) |
| `aliyss/migros-api-wrapper` | Guest-token Migros API wrapper and endpoint discovery | Maintainer says Migros API changes in small ways; unofficial and not affiliated | [GitHub](https://github.com/aliyss/migros-api-wrapper) |
| Open Food Facts API | Ingredients, nutrition, allergens, images, open product data | Volunteer data has no accuracy/completeness guarantee; better enrichment than retailer price truth | [API docs](https://openfoodfacts.github.io/openfoodfacts-server/api/) |
| Open Prices | Crowdsourced food prices through API/dataset | Coverage may be sparse for Swiss chains; price observations need freshness/confidence labels | [API docs](https://prices.openfoodfacts.org/api/docs), [GitHub](https://github.com/openfoodfacts/open-prices) |
| FoodRepo | Swiss grocery product database/API heritage | Need verify current availability, license, coverage, update freshness, and API terms | [API docs](https://www.foodrepo.org/api-docs/swaggers/v3) |
| Pepesto | Paid normalized European grocery API; advertises Migros/Coop/Aldi catalog, prices, unit prices, daily indexing | Paid third-party dependency; must validate terms, coverage, freshness, schema, and cost before adoption | [European API](https://www.pepesto.com/supermarkets/), [Migros API page](https://www.pepesto.com/supermarkets/migros/) |

Gemini planning pass agreed with the immediate technical direction: introduce an honest unsupported adapter, purge static runtime data, refactor tests away from static fixtures as default behavior, and align docs. It also repeated the larger concern from the audit: local runtime crawling is not a production-grade answer for broad product search.

## Target Capability Model

Capabilities must be tracked independently by chain:

| Capability | Production Status Meaning |
|---|---|
| `productSearch` | Queryable product results from approved source, provider API, or maintained index |
| `promotions` | Current promotions from approved source with validity windows |
| `storeSearch` | Real store locator source with provenance and distance support where coordinates are supplied |
| `availability` | Store-specific stock evidence; otherwise unsupported, never inferred |
| `nutrition` | Source-backed nutrition/allergen data, preferably enriched by Open Food Facts/FoodRepo with confidence labels |
| `priceComparison` | Derived service over source-backed product/promotion offers only |

Default runtime should be allowed to have fewer features, but not fake ones.

## File Structure

### Create

- `src/adapters/unsupportedAdapter.ts`  
  Production adapter for chains/capabilities without a real source. It implements `ChainAdapter` and returns explicit `REAL_SOURCE_NOT_IMPLEMENTED` or `SOURCE_TERMS_BLOCKED` errors.

- `src/adapters/sourceRegistry.ts`  
  Central capability registry for all chains. It defines source status per capability and constructs live/unsupported adapters.

- `src/services/sourceStatusService.ts`  
  Read-only service that exposes configured capability status plus observed adapter metadata.

- `src/services/sourceCircuitBreaker.ts`  
  Lightweight fail-fast guard for repeated upstream failures, scoped per provider/capability.

- `src/services/sourceStatusService.test.ts`  
  Tests source status output and static-free chain reporting.

- `src/util/sourceTelemetry.ts`  
  Structured logging helpers for upstream latency, cache hit/miss, warning codes, and provider failures.

- `src/tools/sourceStatus.ts`  
  Tool schema/handler helpers for source status if `handlers.ts` becomes too large.

- `.github/workflows/ci.yml`  
  CI quality gate for lint, test, build.

- `docs/active/SOURCE_PROVIDER_DECISION_RECORD.md`  
  Decision record comparing paid provider, open data, maintained index, and local crawling.

### Modify

- `src/adapters/index.ts`  
  Remove static imports. Build runtime adapters from `sourceRegistry.ts`.

- `src/tools/handlers.ts`  
  Add `get_source_status`; ensure unsupported chains are visible to clients.

- `src/index.ts`  
  Wire `sourceStatusService` into tool dependencies.

- `src/adapters/types.ts`  
  Add capability-level status types.

- `src/services/searchService.ts`  
  Preserve partial-success behavior, but ensure unsupported chains surface warnings rather than disappearing behind empty data.

- `src/services/priceComparisonService.ts`  
  Ensure comparisons use only source-backed offers; all unsupported requested chains appear in metadata.

- `src/adapters/index.test.ts`  
  Assert default runtime does not instantiate static adapters and reports unsupported chains.

- `src/tools/handlers.test.ts`  
  Add `get_source_status` coverage.

- `src/index.integration.test.ts`  
  Add static-free runtime guard.

- `src/services/searchService.test.ts`  
  Replace `legacy-static` default tests with explicit production-like adapter test doubles or live adapter fixture tests.

- `src/services/priceComparisonService.test.ts`  
  Replace `legacy-static` dependency with explicit source-backed test doubles.

- `README.md`  
  Replace aspirational feature claims with actual source-backed support matrix.

- `docs/active/IMPLEMENTATION_TRACKER.md`  
  Update after each meaningful change.

### Delete Or Quarantine

- Delete `src/adapters/staticCatalog.ts` from production source tree.
- Delete `src/adapters/staticChainAdapter.ts` from production source tree.
- Delete `dataMode: "legacy-static"` from runtime adapter options.
- If deterministic sample data is still needed, keep it under test-only fixture paths such as `fixtures/test-only/` and ensure no `src/` runtime file imports it.

## Phase 0: Source Decision And Safety Gate

### Task 0.1: Write The Source Provider Decision Record

**Files:**
- Create: `docs/active/SOURCE_PROVIDER_DECISION_RECORD.md`
- Modify: `docs/active/IMPLEMENTATION_TRACKER.md`

- [ ] **Step 1: Document the four viable source strategies**

Add a decision record with these options:

```markdown
# Source Provider Decision Record

Date: 2026-06-15
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
```

- [ ] **Step 2: Record verification questions for external options**

Include this checklist:

```markdown
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
```

- [ ] **Step 3: Update tracker**

Add a status row:

```markdown
| Source provider decision record | done | `docs/active/SOURCE_PROVIDER_DECISION_RECORD.md` compares official APIs, paid providers, maintained index, and local crawling; local crawling rejected for broad product search |
```

### Task 0.2: Add A Static-Free Runtime Guard Test

**Files:**
- Modify: `src/adapters/index.test.ts`

- [ ] **Step 1: Write failing static-free import behavior test**

Replace the legacy-static test with assertions like:

```ts
it('does not expose legacy static mode in default adapter creation', () => {
  const adapters = createDefaultAdapters({ cacheDirectory: 'test-cache' });

  expect(adapters).toHaveLength(8);
  expect(adapters.map((adapter) => adapter.constructor.name)).not.toContain('StaticChainAdapter');
});
```

- [ ] **Step 2: Run targeted test and verify failure before implementation**

Run:

```powershell
npm test -- --run src/adapters/index.test.ts
```

Expected: failure because current runtime still exposes static behavior and the old test imports `StaticChainAdapter`.

## Phase 1: Remove Static Runtime And Fake Fallbacks

### Task 1.1: Implement `UnsupportedChainAdapter`

**Files:**
- Create: `src/adapters/unsupportedAdapter.ts`
- Test: `src/adapters/unsupportedAdapter.test.ts`

- [ ] **Step 1: Write adapter tests**

Test cases:

```ts
it('returns REAL_SOURCE_NOT_IMPLEMENTED for product search', async () => {
  const adapter = new UnsupportedChainAdapter('coop', {
    productSearch: 'No approved Coop product source is implemented.',
  });

  const result = await adapter.searchProducts({ query: 'milk' });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(SourceWarningCode.RealSourceNotImplemented);
    expect(result.error.message).toContain('Coop product source');
  }
});

it('returns unsupported availability without pretending a store exists', async () => {
  const adapter = new UnsupportedChainAdapter('coop', {});

  const result = await adapter.lookupStoreProductAvailability({
    storeId: 'any-store',
    query: 'milk',
  });

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.data.supported).toBe(false);
    expect(result.data.isAvailable).toBe(false);
    expect(result.data.matches).toEqual([]);
  }
});
```

- [ ] **Step 2: Implement adapter**

Implementation shape:

```ts
export class UnsupportedChainAdapter implements ChainAdapter {
  public constructor(
    public readonly chain: Chain,
    private readonly reasons: Partial<Record<SourceCapability, string>> = {}
  ) {}

  public async searchProducts(): Promise<Result<NormalizedProduct[]>> {
    return this.notImplemented('productSearch');
  }

  public async searchPromotions(): Promise<Result<NormalizedPromotion[]>> {
    return this.notImplemented('promotions');
  }

  public async findStores(): Promise<Result<NormalizedStore[]>> {
    return this.notImplemented('storeSearch');
  }

  public getStoreAvailabilitySupport(): StoreAvailabilitySupport {
    return {
      chain: this.chain,
      supported: false,
      reason: this.reason('availability'),
    };
  }

  public async lookupStoreProductAvailability(
    filters: StoreProductAvailabilityFilters
  ): Promise<Result<StoreProductAvailabilityResult>> {
    return {
      ok: true,
      data: {
        chain: this.chain,
        storeId: filters.storeId,
        query: filters.query,
        supported: false,
        reason: this.reason('availability'),
        matches: [],
        isAvailable: false,
      },
    };
  }
}
```

Define `SourceCapability` in `types.ts` before this step:

```ts
export type SourceCapability =
  | 'productSearch'
  | 'promotions'
  | 'storeSearch'
  | 'availability'
  | 'nutrition';
```

- [ ] **Step 3: Make unsupported messages useful to MCP clients**

Every unsupported error message must include:

- the chain
- the capability
- the reason it is unavailable
- a hint to call `get_source_status`
- any currently supported nearby capability

Example:

```text
Coop product search is unsupported because no approved Coop product source is implemented. Call get_source_status for current chain support. Current source-backed capabilities are Denner promotions and constrained Aldi product search.
```

- [ ] **Step 4: Run adapter tests**

Run:

```powershell
npm test -- --run src/adapters/unsupportedAdapter.test.ts
```

Expected: all tests pass.

### Task 1.2: Replace Default Static Adapters

**Files:**
- Modify: `src/adapters/index.ts`
- Modify: `src/adapters/index.test.ts`

- [ ] **Step 1: Remove static imports and `legacy-static` mode**

Remove:

```ts
import { STATIC_CHAIN_CATALOG } from './staticCatalog.js';
import { StaticChainAdapter } from './staticChainAdapter.js';
dataMode?: 'live-beta' | 'legacy-static';
```

- [ ] **Step 2: Configure default adapter map**

Default runtime:

```ts
export function createDefaultAdapters(options: CreateDefaultAdaptersOptions = {}): ChainAdapter[] {
  return ALL_CHAINS.map((chain) => {
    if (chain === 'aldi') return createAldiLiveAdapter(options);
    if (chain === 'denner') return createDennerPromotionsAdapter(options);

    return new UnsupportedChainAdapter(chain, UNSUPPORTED_CHAIN_REASONS[chain]);
  });
}
```

Important Denner change:

- `DennerPromotionsAdapter` must no longer delegate product/store behavior to `StaticChainAdapter`.
- Give it an `UnsupportedChainAdapter('denner', reasons)` delegate instead.
- Denner promotions remain live-beta.
- Denner product search becomes explicitly unsupported.

- [ ] **Step 3: Run default adapter tests**

Run:

```powershell
npm test -- --run src/adapters/index.test.ts src/adapters/live/dennerPromotionsAdapter.test.ts
```

Expected: Denner promotions still pass; Denner product search static test is replaced with unsupported behavior.

### Task 1.3: Delete Static Source Files From Runtime

**Files:**
- Delete: `src/adapters/staticCatalog.ts`
- Delete: `src/adapters/staticChainAdapter.ts`
- Delete or rewrite: `src/adapters/staticChainAdapter.test.ts`

- [ ] **Step 1: Remove static tests that validate fake business behavior**

Delete `src/adapters/staticChainAdapter.test.ts`. Move matcher-specific tests to `src/util/matcher.test.ts` only if they test generic matching utilities and not fake product catalog behavior.

- [ ] **Step 2: Find remaining static imports**

Run:

```powershell
rg -n "StaticChainAdapter|STATIC_CHAIN_CATALOG|legacy-static|staticCatalog|staticChainAdapter" src docs README.md package.json
```

Expected: no matches in `src/` except historical docs that explicitly describe removed behavior.

- [ ] **Step 3: Run full test suite**

Run:

```powershell
npm test -- --run
```

Expected: failures only in tests that still assumed static data. Fix those in Task 1.4.

### Task 1.4: Refactor Service And Tool Tests Away From Static Catalog Assumptions

**Files:**
- Modify: `src/services/searchService.test.ts`
- Modify: `src/services/priceComparisonService.test.ts`
- Modify: `src/tools/handlers.test.ts`
- Modify: `src/index.integration.test.ts`

- [ ] **Step 1: Replace static default service tests**

Use explicit test doubles built in the test file:

```ts
const service = new SearchService([
  stubAdapter('migros', {
    products: [
      {
        id: 'observed-milk',
        chain: 'migros',
        name: 'Observed Milk',
        price: { current: 1.85, unit: { value: 1, per: 'l' } },
        provenance: observedRetailerWebProvenance('migros'),
      },
    ],
  }),
]);
```

The test product is not a fallback. It is test input for a service unit test.
It must include provenance whenever it represents source-backed data.

- [ ] **Step 2: Add unsupported-chain warning tests**

Add tests where `UnsupportedChainAdapter` is requested with a live adapter:

```ts
const service = new SearchService([
  liveLikeAdapter('aldi', [sourceBackedProduct('aldi-bread', 'aldi')]),
  new UnsupportedChainAdapter('coop', {
    productSearch: 'No approved Coop product source is implemented.',
  }),
]);

const result = await service.searchProducts({ query: 'bread', chains: ['aldi', 'coop'] });

expect(result.ok).toBe(true);
if (result.ok) {
  expect(result.data).toHaveLength(1);
  expect(result.metadata?.sourceWarnings).toEqual([
    expect.objectContaining({
      chain: 'coop',
      code: SourceWarningCode.RealSourceNotImplemented,
    }),
  ]);
}
```

- [ ] **Step 3: Update integration tests**

Remove `createServer({ adapterOptions: { dataMode: 'legacy-static' } })`. Use:

```ts
const server = await createServer({
  adapterOptions: {
    cacheDirectory: testCacheDirectory,
    fetchImpl: fakeFetch,
  },
});
```

The fake fetch must serve Aldi/Denner fixtures through the production live adapters.

- [ ] **Step 4: Run targeted tests**

Run:

```powershell
npm test -- --run src/services/searchService.test.ts src/services/priceComparisonService.test.ts src/tools/handlers.test.ts src/index.integration.test.ts
```

Expected: all pass.

## Phase 2: Capability Source Status

### Task 2.1: Add Capability-Level Source Status Types

**Files:**
- Modify: `src/adapters/types.ts`

- [ ] **Step 1: Add capability status model**

```ts
export type SourceCapability =
  | 'productSearch'
  | 'promotions'
  | 'storeSearch'
  | 'availability'
  | 'nutrition';

export interface CapabilitySourceStatus {
  chain: Chain;
  capability: SourceCapability;
  status:
    | 'unsupported'
    | 'blocked'
    | 'source-auditing'
    | 'live-beta'
    | 'live-stable'
    | 'degraded';
  provider?: string;
  sourceType?: SourceType;
  sourceUrl?: string;
  lastObservedAt?: string;
  warning?: SourceWarning;
  reason?: string;
}
```

- [ ] **Step 2: Run build to catch type errors**

Run:

```powershell
npm run build
```

Expected: build passes before services use the type.

### Task 2.2: Implement Source Registry

**Files:**
- Create: `src/adapters/sourceRegistry.ts`
- Test: `src/adapters/sourceRegistry.test.ts`

- [ ] **Step 1: Define static configuration as status, not fake data**

Example:

```ts
export const SOURCE_REGISTRY: Record<Chain, CapabilitySourceStatus[]> = {
  aldi: [
    { chain: 'aldi', capability: 'productSearch', status: 'live-beta', provider: 'ALDI SUISSE', sourceType: 'retailer-web' },
    { chain: 'aldi', capability: 'promotions', status: 'unsupported', reason: 'No approved Aldi promotions source is implemented.' },
    { chain: 'aldi', capability: 'storeSearch', status: 'unsupported', reason: 'No approved Aldi store source implemented.' },
    { chain: 'aldi', capability: 'availability', status: 'unsupported', reason: 'No store-level Aldi availability source implemented.' },
    { chain: 'aldi', capability: 'nutrition', status: 'unsupported', reason: 'No Aldi nutrition enrichment source is implemented.' },
  ],
  denner: [
    { chain: 'denner', capability: 'promotions', status: 'live-beta', provider: 'Denner', sourceType: 'retailer-web' },
    { chain: 'denner', capability: 'productSearch', status: 'unsupported', reason: 'No approved Denner catalog source implemented.' },
    { chain: 'denner', capability: 'storeSearch', status: 'unsupported', reason: 'No approved Denner store source is implemented.' },
    { chain: 'denner', capability: 'availability', status: 'unsupported', reason: 'No Denner store-level availability source is implemented.' },
    { chain: 'denner', capability: 'nutrition', status: 'unsupported', reason: 'No Denner nutrition enrichment source is implemented.' },
  ],
  coop: [
    { chain: 'coop', capability: 'productSearch', status: 'blocked', reason: 'Source audit found search endpoints blocked or unsuitable.' },
    { chain: 'coop', capability: 'promotions', status: 'blocked', reason: 'No approved Coop promotions source is implemented.' },
    { chain: 'coop', capability: 'storeSearch', status: 'source-auditing', reason: 'Store source requires endpoint audit.' },
    { chain: 'coop', capability: 'availability', status: 'unsupported', reason: 'No Coop store-level availability source is implemented.' },
    { chain: 'coop', capability: 'nutrition', status: 'unsupported', reason: 'No Coop nutrition enrichment source is implemented.' },
  ],
  farmy: [
    { chain: 'farmy', capability: 'productSearch', status: 'blocked', reason: 'Source audit found Farmy operations ceased.' },
    { chain: 'farmy', capability: 'promotions', status: 'blocked', reason: 'Source audit found Farmy operations ceased.' },
    { chain: 'farmy', capability: 'storeSearch', status: 'blocked', reason: 'Source audit found Farmy operations ceased.' },
    { chain: 'farmy', capability: 'availability', status: 'blocked', reason: 'Source audit found Farmy operations ceased.' },
    { chain: 'farmy', capability: 'nutrition', status: 'blocked', reason: 'Source audit found Farmy operations ceased.' },
  ],
  lidl: [
    { chain: 'lidl', capability: 'productSearch', status: 'source-auditing', reason: 'Product sitemap feasibility still needs parser and source review.' },
    { chain: 'lidl', capability: 'promotions', status: 'unsupported', reason: 'No approved Lidl promotions source is implemented.' },
    { chain: 'lidl', capability: 'storeSearch', status: 'source-auditing', reason: 'Store finder sitemap requires audit.' },
    { chain: 'lidl', capability: 'availability', status: 'unsupported', reason: 'No Lidl store-level availability source is implemented.' },
    { chain: 'lidl', capability: 'nutrition', status: 'unsupported', reason: 'No Lidl nutrition enrichment source is implemented.' },
  ],
  migros: [
    { chain: 'migros', capability: 'productSearch', status: 'blocked', reason: 'Source audit found product search source blocked or unsuitable without provider/index decision.' },
    { chain: 'migros', capability: 'promotions', status: 'blocked', reason: 'Source audit found promotion paths blocked.' },
    { chain: 'migros', capability: 'storeSearch', status: 'source-auditing', reason: 'Public store source requires audit before runtime use.' },
    { chain: 'migros', capability: 'availability', status: 'unsupported', reason: 'No Migros store-level availability source is implemented.' },
    { chain: 'migros', capability: 'nutrition', status: 'source-auditing', reason: 'Open-data or provider enrichment decision required.' },
  ],
  ottos: [
    { chain: 'ottos', capability: 'productSearch', status: 'source-auditing', reason: 'Category/product pages need high-caution audit.' },
    { chain: 'ottos', capability: 'promotions', status: 'source-auditing', reason: 'Promotion source needs high-caution audit.' },
    { chain: 'ottos', capability: 'storeSearch', status: 'source-auditing', reason: 'Store source requires audit.' },
    { chain: 'ottos', capability: 'availability', status: 'unsupported', reason: "No Otto's store-level availability source is implemented." },
    { chain: 'ottos', capability: 'nutrition', status: 'unsupported', reason: "No Otto's nutrition enrichment source is implemented." },
  ],
  volg: [
    { chain: 'volg', capability: 'productSearch', status: 'blocked', reason: 'Source audit found no product catalog or price source.' },
    { chain: 'volg', capability: 'promotions', status: 'source-auditing', reason: 'Promotion source requires audit.' },
    { chain: 'volg', capability: 'storeSearch', status: 'source-auditing', reason: 'Store locator source requires audit.' },
    { chain: 'volg', capability: 'availability', status: 'unsupported', reason: 'No Volg store-level availability source is implemented.' },
    { chain: 'volg', capability: 'nutrition', status: 'unsupported', reason: 'No Volg nutrition enrichment source is implemented.' },
  ],
};
```

This configuration is production metadata, not product data.

- [ ] **Step 2: Test every chain/capability has a status**

Test:

```ts
for (const chain of ALL_CHAINS) {
  expect(getCapabilityStatuses(chain).length).toBeGreaterThan(0);
}
```

- [ ] **Step 3: Run registry tests**

Run:

```powershell
npm test -- --run src/adapters/sourceRegistry.test.ts
```

Expected: pass.

### Task 2.3: Add `get_source_status` MCP Tool

**Files:**
- Modify: `src/tools/handlers.ts`
- Modify: `src/index.ts`
- Test: `src/tools/handlers.test.ts`
- Test: `src/index.integration.test.ts`

- [ ] **Step 1: Add tool schema**

Input:

```ts
const sourceStatusInputSchema = z
  .object({
    chains: z.array(chainEnum).min(1).optional(),
    capabilities: z
      .array(z.enum(['productSearch', 'promotions', 'storeSearch', 'availability', 'nutrition']))
      .min(1)
      .optional(),
  })
  .strict();
```

- [ ] **Step 2: Add handler output**

Output:

```json
{
  "statuses": [
    {
      "chain": "coop",
      "capability": "productSearch",
      "status": "blocked",
      "reason": "Source audit found search endpoints blocked or unsuitable."
    }
  ]
}
```

- [ ] **Step 3: Run handler and integration tests**

Run:

```powershell
npm test -- --run src/tools/handlers.test.ts src/index.integration.test.ts
```

Expected: `listTools` includes `get_source_status`; calls return status matrix.

## Phase 3: Honest Runtime Behavior

### Task 3.1: Make Empty Results Distinct From Unsupported Sources

**Files:**
- Modify: `src/services/searchService.ts`
- Modify: `src/services/priceComparisonService.ts`
- Test: `src/services/searchService.test.ts`
- Test: `src/services/priceComparisonService.test.ts`

- [ ] **Step 1: Verify unsupported chains become metadata warnings**

For mixed chains:

```ts
searchProducts({ query: 'bread', chains: ['aldi', 'coop'] })
```

Expected:

- `ok: true` if Aldi returns source-backed products.
- `metadata.sourceWarnings` contains Coop `REAL_SOURCE_NOT_IMPLEMENTED` or `SOURCE_TERMS_BLOCKED`.

For only unsupported chains:

```ts
searchProducts({ query: 'bread', chains: ['coop'] })
```

Expected:

- `ok: false`
- `error.code: "ALL_SOURCES_FAILED"`
- Message names the unsupported chain and reason.

- [ ] **Step 2: Ensure comparison never ranks unsupported chains**

`comparePrices({ query: 'milk', chains: ['coop'] })` must not return fake offers.
It must fail with `ALL_SOURCES_FAILED` or return an empty source-backed result
only if a real provider reports no matches.

- [ ] **Step 3: Run service tests**

Run:

```powershell
npm test -- --run src/services/searchService.test.ts src/services/priceComparisonService.test.ts
```

Expected: pass.

### Task 3.2: Add Source Telemetry And Fail-Fast Policy

**Files:**
- Create: `src/services/sourceCircuitBreaker.ts`
- Create: `src/services/sourceCircuitBreaker.test.ts`
- Create: `src/util/sourceTelemetry.ts`
- Modify: `src/sources/sourceClient.ts`
- Modify: live adapters as needed

- [ ] **Step 1: Add circuit breaker tests**

Test behavior:

```ts
it('opens after repeated failures and fails fast until cooldown expires', () => {
  const clock = fakeClock(new Date('2026-06-15T10:00:00.000Z'));
  const breaker = new SourceCircuitBreaker({ failureThreshold: 5, cooldownMs: 60_000, clock });

  for (let index = 0; index < 5; index += 1) {
    breaker.recordFailure('pepesto:productSearch');
  }

  expect(breaker.canAttempt('pepesto:productSearch')).toBe(false);

  clock.advanceMs(60_001);
  expect(breaker.canAttempt('pepesto:productSearch')).toBe(true);
});
```

- [ ] **Step 2: Implement circuit breaker**

Use provider/capability keys such as `aldi:productSearch`, `denner:promotions`,
and `pepesto:productSearch`. Open breakers should return `SOURCE_UNAVAILABLE`
warnings immediately instead of letting tool calls hang on repeated upstream
failures.

- [ ] **Step 3: Add structured source telemetry**

Log one structured event per upstream attempt:

```ts
logSourceAttempt({
  provider: 'Denner',
  chain: 'denner',
  capability: 'promotions',
  sourceUrl,
  elapsedMs,
  outcome: 'success' | 'warning' | 'error',
  warningCode,
  cache: 'hit' | 'miss' | 'stale' | 'none',
});
```

No product names, user queries, API keys, or account identifiers should be
logged.

- [ ] **Step 4: Verify existing timeout behavior**

`SourceHttpClient` already has an `AbortController` timeout. Add tests that
confirm configured timeout failures become `SOURCE_UNAVAILABLE` warnings and do
not block beyond the configured timeout budget.

## Phase 4: Stabilize Existing Live-Beta Surfaces

### Task 4.1: Promote Denner Promotions As First Production Candidate

**Files:**
- Modify: `src/adapters/live/dennerPromotionsAdapter.ts`
- Modify: `src/parsers/denner.ts`
- Test: `src/adapters/live/dennerPromotionsAdapter.test.ts`
- Test: `src/parsers/denner.test.ts`
- Docs: `docs/active/DENNER_PROMOTIONS_IMPLEMENTATION_PLAN.md`

- [ ] **Step 1: Remove static delegate**

Denner adapter should compose:

```ts
const delegate = new UnsupportedChainAdapter('denner', {
  productSearch: 'Denner product catalog search is not backed by a real source yet.',
  storeSearch: 'Denner store lookup is not backed by a real source yet.',
  availability: 'Denner store-level availability is not backed by a real source.',
});
```

- [ ] **Step 2: Add parser drift tests**

Use current fixture plus one minimized HTML card fixture. Tests must assert:

- price parsed
- original price parsed when present
- discount parsed when present
- validity window parsed
- parse failure throws when no cards are present

- [ ] **Step 3: Add live smoke criteria**

Update `test:live` or add `test:live:denner`:

```json
"test:live:denner": "vitest run --passWithNoTests src/adapters/live/dennerPromotionsAdapter.live.test.ts"
```

Live test runs only when `LIVE_SOURCE_TESTS=1`.

### Task 4.2: Decide Aldi Product Search Fate

**Files:**
- Modify: `docs/active/ALDI_LIVE_BETA_ADAPTER.md`
- Modify: `docs/active/SOURCE_PROVIDER_DECISION_RECORD.md`

- [ ] **Step 1: Downgrade or constrain Aldi scope**

Document one of these decisions:

- Keep Aldi live-beta only for exact URL/sitemap-term lookup, not broad catalog search.
- Or replace Aldi live-beta product search with provider/index architecture.

- [ ] **Step 2: Add acceptance criteria for keeping Aldi enabled**

Aldi remains enabled only if all are true:

- Query recall is measured against a known source sample.
- Cold-cache latency stays within MCP tool timeout budget.
- Rate-limit behavior is documented.
- Unit price/size parsing is added or comparison marks Aldi unit comparison ineligible.
- Source warnings are returned on partial page failures.

## Phase 5: Real Store Search Before Broad Catalog Search

### Task 5.1: Add Store Search Source Interface

**Files:**
- Create: `src/sources/storeSource.ts`
- Modify: `src/adapters/types.ts`
- Test: `src/sources/storeSource.test.ts`

- [ ] **Step 1: Define source record**

```ts
export interface ObservedStoreRecord {
  id: string;
  chain: Chain;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  openingHours?: string;
  sourceUrl?: string;
  observedAt: string;
}
```

- [ ] **Step 2: Add distance utility**

Create or extend util:

```ts
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const earthRadiusKm = 6371;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
}
```

- [ ] **Step 3: Extend store filters**

Add optional:

```ts
latitude?: number;
longitude?: number;
radiusKm?: number;
```

Keep `location` for text lookup.

### Task 5.2: Implement First Real Store Adapter

**Files:**
- Create: `src/adapters/live/aldiStoreAdapter.ts` or integrate into `AldiLiveAdapter`
- Test: fixture and fake transport tests

- [ ] **Step 1: Audit Aldi store sitemap/page source**

Use only sources approved by `SOURCE_AUDIT.md`. If the sitemap is too large or pages lack structured data, mark Aldi store search unsupported and choose a smaller store source.

- [ ] **Step 2: Cache the country store list before filtering**

If the provider/source cannot filter by radius server-side, fetch the complete
store list at most once per cache TTL, store it with provenance, and apply
Haversine filtering against the cached list. Do not fetch all Swiss stores on
every `find_stores` call.

Recommended default:

```ts
const STORE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
```

- [ ] **Step 3: Implement fixture parser**

Parser must map source records to `NormalizedStore` with provenance.

- [ ] **Step 4: Add geospatial filtering tests**

Test:

- within radius included
- outside radius excluded
- results sorted by distance when coordinates supplied
- text location still works
- source fetched once, subsequent radius lookups use cached store list

## Phase 6: Product Search Architecture

### Task 6.1: Add Provider Abstraction, Not Retailer-Specific Crawling

**Files:**
- Create: `src/providers/productProvider.ts`
- Create: `src/providers/providerProductMapper.ts`
- Test: `src/providers/productProvider.test.ts`

- [ ] **Step 1: Define provider interface**

```ts
export interface ProductProvider {
  readonly providerName: string;
  searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>>;
  getCapabilityStatuses(): CapabilitySourceStatus[];
}
```

- [ ] **Step 2: Add provider decision config**

Environment variables:

```text
SWISS_SHOPPING_PRODUCT_PROVIDER=none|pepesto|open-data|custom-index
SWISS_SHOPPING_PROVIDER_API_KEY=provider-issued-api-key
```

Default must be `none`, which returns unsupported status rather than fake data.

### Task 6.2: Evaluate Pepesto As Fastest Near-Production Path

**Files:**
- Create: `src/providers/pepestoProvider.ts`
- Test: `src/providers/pepestoProvider.test.ts`
- Docs: `docs/active/SOURCE_PROVIDER_DECISION_RECORD.md`

- [ ] **Step 1: Do contract verification before coding**

Record answers:

- Does the license allow MCP runtime use and result display?
- Which Swiss chains are covered today?
- What freshness is guaranteed?
- What rate limits apply?
- Does API return stable IDs/EANs/unit prices/promotions?
- Does pricing match Swiss stores or online-only prices?

- [ ] **Step 2: Implement only after verification**

Adapter maps provider products into `NormalizedProduct` with:

- `provenance.provider = "Pepesto"`
- `sourceType = "third-party"`
- `freshness = "live"` or `"cached"` based on response/cache
- source warning on provider failure

- [ ] **Step 3: Add fake transport tests**

Tests use provider response fixtures, not invented fallback catalog data.

### Task 6.3: Add Open Data Enrichment, Not Price Truth

**Files:**
- Create: `src/providers/openFoodFactsEnrichment.ts`
- Create: `src/providers/openPricesProvider.ts`
- Test: provider fixture tests

- [ ] **Step 1: Use Open Food Facts for nutrition/allergen enrichment**

Only enrich when a source-backed product has EAN or reliable identifier. Keep
enrichment opt-in or lazy because it adds extra upstream calls and can dominate
MCP tool latency.

Add an explicit input flag before enabling it in user-facing tools:

```ts
enrichNutrition?: boolean;
```

Default:

```ts
enrichNutrition: false
```

Mark confidence:

```ts
provenance: {
  provider: 'Open Food Facts',
  sourceType: 'open-data',
  confidence: 'medium'
}
```

- [ ] **Step 2: Use Open Prices only as observed price evidence**

Open Prices results must include:

- observed timestamp
- location/store if available
- confidence lower than retailer/provider prices unless coverage is proven
- no automatic use in price comparison unless caller opts into observed/crowd
  price evidence

## Phase 6.5: Latency Budgets

### Task 6.5.1: Define Tool-Level Time Budgets

**Files:**
- Modify: `src/tools/handlers.ts`
- Modify: `src/sources/sourceClient.ts`
- Test: `src/tools/handlers.test.ts`

- [ ] **Step 1: Document default budgets**

Use these defaults unless a source-specific decision record overrides them:

| Tool | Default budget |
|---|---:|
| `search_products` | 8 seconds |
| `search_promotions` | 8 seconds |
| `find_stores` | 8 seconds |
| `compare_prices` | 10 seconds |
| `get_source_status` | 1 second |

- [ ] **Step 2: Ensure all live/provider calls respect budget**

Pass timeout budgets into source/provider calls. If the budget is exceeded,
return source warnings or `ALL_SOURCES_FAILED`; never continue background work
inside an MCP request.

## Phase 7: Documentation And Packaging Honesty

### Task 7.1: Rewrite README Support Matrix

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace feature claims**

Use a support table:

```markdown
| Chain | Product Search | Promotions | Store Search | Availability |
|---|---|---|---|---|
| Aldi | live-beta, constrained | unsupported | unsupported | unsupported |
| Denner | unsupported | live-beta | unsupported | unsupported |
| Migros | blocked/pending provider | unsupported | unsupported | unsupported |
```

- [ ] **Step 2: Add data trust policy**

```markdown
This server does not return demo or invented grocery data in default runtime.
If a source is missing, blocked, or degraded, tools return explicit source
warnings or errors.
```

### Task 7.2: Fix Package And CI

**Files:**
- Modify: `package.json`
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Replace placeholder metadata**

Update:

```json
{
  "author": "Project maintainers",
  "files": ["dist", "README.md", "LICENSE"],
  "scripts": {
    "clean": "node -e \"require('fs').rmSync('dist', { recursive: true, force: true })\""
  }
}
```

- [ ] **Step 2: Add CI workflow**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm test -- --run
      - run: npm run build
```

## Phase 8: Final Production Readiness Gate

### Task 8.1: Add Release Gate Checklist

**Files:**
- Create: `docs/active/PRODUCTION_RELEASE_CHECKLIST.md`

- [ ] **Step 1: Add required checks**

Checklist:

```markdown
- [ ] `rg -n "StaticChainAdapter|STATIC_CHAIN_CATALOG|legacy-static" src` returns no matches.
- [ ] `npm run lint` passes.
- [ ] `npm test -- --run` passes.
- [ ] `npm run build` passes.
- [ ] `get_source_status` reports every chain/capability.
- [ ] README support matrix matches `get_source_status`.
- [ ] Every enabled live source has fixture tests and opt-in live smoke tests.
- [ ] No source marked `live-stable` without repeated successful live checks.
- [ ] Product search provider decision is recorded.
```

### Task 8.2: Run Final Verification

Run:

```powershell
npm run lint
npm test -- --run
npm run build
rg -n "StaticChainAdapter|STATIC_CHAIN_CATALOG|legacy-static|staticCatalog|staticChainAdapter" src
```

Expected:

- lint pass
- tests pass
- build pass
- `rg` returns no matches in `src`

## Implementation Priority

1. Phase 1: remove static runtime and fake fallbacks.
2. Phase 2: expose source status.
3. Phase 7: rewrite README so user-facing claims stop lying.
4. Phase 4: stabilize Denner promotions as the first credible live capability.
5. Phase 5: implement real store search because it is more feasible than broad product search.
6. Phase 6: decide and implement product search provider/index architecture.
7. Phase 8: release checklist and final production gate.

## Acceptance Criteria

Near-production is reached when:

- Default runtime has zero static product/store/availability catalog imports.
- Static/demo data is not a runtime feature.
- Unsolved chains return explicit unsupported/blocked status.
- At least Denner promotions work through source-backed live-beta behavior.
- Store/product claims in README match source status.
- CI passes.
- A product search architecture decision is recorded and implemented for at least one source, or product search is honestly marked unsupported except constrained Aldi live-beta.

## What Not To Do

- Do not keep `legacy-static` as a runtime switch.
- Do not hide failed live sources behind empty arrays unless the source truly returned no matches.
- Do not claim multi-chain product search until it is source-backed.
- Do not expand local crawler logic as the broad product search solution.
- Do not use Open Food Facts/Open Prices as complete retailer truth without measured coverage and freshness.
