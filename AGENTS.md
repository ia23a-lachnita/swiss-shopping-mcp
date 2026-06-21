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
4. Build and test (see commands below)
5. Update tracker

## Build & Run commands

**IMPORTANT:** `pnpm`, `npm`, `npx` are NOT in PATH. Always use the full node path:

```powershell
# Node executable (always use this)
$NODE = "C:\Users\xursc\AppData\Local\nvm\v24.12.0\node.exe"

# Build TypeScript
& $NODE "node_modules\typescript\bin\tsc" --project tsconfig.json

# Run vitest
& $NODE "node_modules\vitest\vitest.mjs" run

# Run Playwright tests
& $NODE "node_modules\@playwright\test\cli.js" test tests/<file>.spec.ts --reporter=list

# Start SPA server (use background process tool)
# DO NOT use bash `node dist/web/server.js` — use createBackgroundProcess instead
```

## SPA Server Management

**ALWAYS** use the `createBackgroundProcess` tool to start the SPA server, and `killTasks` to stop it.

```powershell
# Start server (createBackgroundProcess with tags=["spa","server"])
createBackgroundProcess: cmd /c "C:\Users\xursc\AppData\Local\nvm\v24.12.0\node.exe dist\web\server.js"

# Stop server
killTasks: tags=["spa", "server"]

# Clear stale cache before restarting (cache is in OS temp dir)
$tmpdir = [System.IO.Path]::GetTempPath()
$cacheDir = Join-Path $tmpdir "swiss-shopping-mcp-cache"
Remove-Item -Path $cacheDir -Recurse -Force -ErrorAction SilentlyContinue
```

## NEVER DO THIS

**NEVER use `taskkill /IM node.exe /F` or any command that kills all node processes.**
This kills opencode itself, the browser MCP server, and every other node process on the system.
It destroys your own tools and session.
Only use `killTasks` with specific tags to stop specific background processes.

## Edit tool policy

- Use `morph_edit` for large files (300+ lines) or multiple scattered changes
- Use native `edit` for small exact string replacements
- Always read the file first before editing
- For SPA HTML (`index.html`, 1000+ lines), prefer `morph_edit` for any change

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
