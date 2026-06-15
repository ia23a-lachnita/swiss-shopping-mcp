# swiss-shopping-mcp - Agent Instructions

## FIRST THING: Read the tracker

Before coding anything, read:
- `docs/active/IMPLEMENTATION_TRACKER.md`

Update the tracker after each meaningful change.

## Project scope

Build a TypeScript MCP server for Swiss retail/grocery discovery and comparison.

### In scope (current)
- Product search across supported Swiss chains
- Normalized product/store/promotion models
- Price comparison and filtering logic
- Strong automated tests for adapters and core services

### Not in scope (unless explicitly requested)
- Mobile automation MCP tooling
- Firebase tooling
- Account/cart checkout integrations in this phase

## Tool / MCP usage policy

Only use development MCPs relevant to this codebase:
- `context7` for library docs
- `context-mode` for large-output command execution
- `gemini-cli` only for optional design/code review second opinion

Do not add runtime/business MCPs (e.g., external shopping/account MCPs) to this repository config.

## Execution workflow

1. Read tracker
2. Implement minimal complete slice
3. Add/adjust tests
4. Run `pnpm lint && pnpm test && pnpm build`
5. Update tracker

## Architecture

### Core modules
- `src/index.ts` - MCP server bootstrap and tool registration
- `src/adapters/` - Per-chain adapter implementations
- `src/services/` - Matching, comparison, planning logic
- `src/util/` - Shared infra utilities

### Normalized model contract
Use `src/adapters/types.ts` as the canonical domain schema:
- `NormalizedProduct`
- `NormalizedStore`
- `NormalizedPromotion`
- `Result<T>`

Adapters translate source data into this contract only.

## Coding standards

- TypeScript strict mode only
- No broad catches or silent failures
- No fake fallbacks that hide integration failures
- Tests required for new behavior
- Keep code and docs aligned

## Definition of done

- Feature works end-to-end in the local MCP server
- Tests cover normal path + edge/error path
- Lint/build/test pass
- Tracker updated

## References

- `README.md` - product and development requirements
- `docs/active/IMPLEMENTATION_TRACKER.md` - phase/state tracking
