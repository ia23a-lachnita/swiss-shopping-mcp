# swiss-shopping-mcp Implementation Tracker

## Current phase

Phase: `V1 - core read/search foundation`

## Goals (V1)

- Define stable normalized domain contracts
- Implement chain adapter skeletons
- Implement searchable product/store tools
- Add automated tests and CI-ready quality gates

## Status

| Area | Status | Notes |
|---|---|---|
| TypeScript scaffold | done | Base project and build scripts exist |
| MCP bootstrap | done | `src/index.ts` server skeleton is running |
| Domain types | done | `src/adapters/types.ts` established |
| Adapter implementations | done | Static multi-chain adapters for all V1 chains; HTTP `MigrosAdapter` in `src/adapters/migros.ts` for future live integration |
| Tool implementations | done | `search_products`, `find_stores`, `compare_prices`, `get_store_availability_support`, `lookup_store_product_availability` wired via `src/tools/handlers.ts` |
| Test baseline | done | Adapter/service/tool-handler/integration tests; HTTP adapter tests in `migros.test.ts` |
| HTTP utility | done | `src/util/http.ts` — `fetchJson` + `HttpError` for use by HTTP adapters |
| Price comparison service | done | `src/services/priceComparisonService.ts` — cross-chain unit-price comparison |
| Search service | done | `src/services/searchService.ts` — multi-chain fan-out with filtering |
| Store availability lookup | done | `get_store_availability_support` and `lookup_store_product_availability`; static Migros adapter supports per-store availability |
| Search usability improvements | done | `matchMode` balanced/literal matching added; pasta-family recall fixed for static catalog |
| Unit-aware price comparison | done | `comparisonBasis` pack/unit ranking, normalized unit eligibility, and `limitPerChain` alternatives implemented |
| Copilot instruction architecture | done | Root and `.github` instruction files realigned |
| Live MCP manual test pass | done | Original 31/31 baseline plus 6/6 follow-up regression cases pass; see `docs/active/MCP_TEST_REPORT.md` (2026-05-18) |

## Next tasks

1. Expand the static taxonomy beyond the initial narrow aliases as more real catalog terms are observed
2. Expand static catalogs or add real upstream API integration for non-Migros chains
3. Activate `MigrosAdapter` (HTTP) in `createDefaultAdapters` when Migros API key/auth is ready
4. Add normalized promotion ingestion and promotion-aware comparison
5. Add richer store geospatial filtering (distance/radius)
6. Prepare V2 account/cart integration foundation

## Decisions

- Development MCP scope is minimal: `context7`, `context-mode`, optional `gemini-cli`
- No mobile/firebase/account MCP tooling in V1 development config
- `pnpm` broken under Node 20.20.0 with corepack pnpm 11.0.9 — use `npm run` for all scripts
- Static adapters power V1; `MigrosAdapter` HTTP adapter kept as future-ready implementation
- Partial adapter failure (HTTP adapter) returns whatever succeeded; all-fail returns error
- Static catalog product search defaults to balanced deterministic matching; callers can request `matchMode: "literal"` for strict token matching
- `compare_prices` defaults to pack-price ranking for compatibility; callers can request `comparisonBasis: "unitPrice"` for normalized unit ranking
- Verification on 2026-05-18: live MCP follow-up regression cases passed; `npm run lint`, `npm test -- --run`, and `npm run build` passed
