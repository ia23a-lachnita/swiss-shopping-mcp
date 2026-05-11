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
| Adapter implementations | done | Static multi-chain adapters implemented for all V1 chains |
| Tool implementations | done | `search_products`, `find_stores`, `compare_prices` wired to service layer |
| Test baseline | done | Adapter/service/tool-handler tests cover success/edge/error paths; MCP client↔server integration tests verify end-to-end tool retrieval over transport |
| Store availability lookup | done | Added `get_store_availability_support` and `lookup_store_product_availability`; currently only Migros has static per-store availability in V1 adapters |
| Copilot instruction architecture | done | Root and `.github` instruction files realigned |

## Next tasks

1. Expand static catalogs with real upstream per-store availability integrations for non-Migros chains
2. Add normalized promotion ingestion and promotion-aware comparison
3. Add richer store geospatial filtering (distance/radius)
4. Prepare V2 account/cart integration foundation

## Decisions

- Development MCP scope is minimal: `context7`, `context-mode`, optional `gemini-cli`
- No mobile/firebase/account MCP tooling in V1 development config
