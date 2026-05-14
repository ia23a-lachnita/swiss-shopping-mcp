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
| Copilot instruction architecture | done | Root and `.github` instruction files realigned |

## Next tasks

1. Expand static catalogs or add real upstream API integration for non-Migros chains
2. Activate `MigrosAdapter` (HTTP) in `createDefaultAdapters` when Migros API key/auth is ready
3. Add normalized promotion ingestion and promotion-aware comparison
4. Add richer store geospatial filtering (distance/radius)
5. Prepare V2 account/cart integration foundation

## Decisions

- Development MCP scope is minimal: `context7`, `context-mode`, optional `gemini-cli`
- No mobile/firebase/account MCP tooling in V1 development config
- `pnpm` broken under Node 20.20.0 with corepack pnpm 11.0.9 — use `npm run` for all scripts
- Static adapters power V1; `MigrosAdapter` HTTP adapter kept as future-ready implementation
- Partial adapter failure (HTTP adapter) returns whatever succeeded; all-fail returns error
