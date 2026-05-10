# Copilot CLI Configuration for swiss-shopping-mcp

## Setup Instructions

This project requires additional MCPs and plugins for full functionality.

### 1. Add MCP Servers

Run these commands from within a Copilot CLI interactive session:

```bash
/mcp add
```

Then add the following servers:

- **swiss-shopping-mcp** (Local/STDIO)
  - Command: `node dist/index.js`
  - Environment: `{"LOG_LEVEL": "info"}`
  - Tools: `*`

- **gemini-cli** (Local/STDIO)
  - Command: `gemini-cli`
  - Tools: `*`

- **mobile-mcp** (Local/STDIO)
  - Command: `mobile-mcp`
  - Tools: `*`

Or copy the `.github/mcp-config.json` to `~/.copilot/mcp-config.json` and merge with existing MCPs.

### 2. Install Plugins

```bash
/plugin install claude-mem context-mode context7 firebase superpowers token-optimizer caveman
```

### 3. Verify Setup

```bash
/env
/mcp show
/plugin list
```

## Development Guidelines

- Use TypeScript strict mode
- Run tests: `! pnpm test`
- Format code: `! pnpm format`
- Lint: `! pnpm lint`
- Build: `! pnpm build`

## Architecture Overview

See `CLAUDE.md` and `.claude/PLAN.md` for complete documentation.

**Key Points:**
- Adapter pattern for multi-chain support (Migros, Coop, Aldi, Denner, Lidl, Farmy, Volg, Otto's)
- Normalized types across all chains
- Account integration planned for V2
- 80%+ test coverage target

## Code Standards

- TypeScript strict mode required
- All public types fully typed
- Tests required for new features
- Comments only for non-obvious logic
- Follow existing patterns in `src/adapters/`
