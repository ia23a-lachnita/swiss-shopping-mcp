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
| Adapter implementations | pending | No chain adapter modules yet |
| Tool implementations | pending | Tool handlers still placeholder (`Unknown tool`) |
| Test baseline | in_progress | Utility tests exist; adapter/tool tests missing |
| Copilot instruction architecture | done | Root and `.github` instruction files realigned |

## Next tasks

1. Implement adapter interface + first concrete chain adapter
2. Wire `search_products` and `find_stores` to real service layer
3. Add tests for request validation and tool execution
4. Add comparison tool for cross-chain pricing

## Decisions

- Development MCP scope is minimal: `context7`, `context-mode`, optional `gemini-cli`
- No mobile/firebase/account MCP tooling in V1 development config
