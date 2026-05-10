# Copilot CLI Setup Guide

This project is configured for **Copilot CLI** (not Claude Desktop). Follow these steps to get started.

## Prerequisites

1. **Copilot CLI installed**: https://github.com/github/gh-copilot
   ```bash
   npm install -g @github/copilot
   # or: brew install copilot-cli
   # or: winget install GitHub.Copilot
   ```

2. **GitHub authentication**: 
   ```bash
   copilot /login
   ```

3. **pnpm installed**:
   ```bash
   npm install -g pnpm
   ```

## Configuration Steps

### 1. Install Required Plugins

From within a Copilot CLI session:

```bash
/plugin install claude-mem context-mode context7 firebase superpowers token-optimizer caveman
```

**What these plugins do:**
- **claude-mem** — Persistent memory across sessions
- **context-mode** — Automatic context optimization
- **context7** — Advanced context aware features
- **firebase** — Real-time data & integration
- **superpowers** — Extended capabilities
- **token-optimizer** — Reduces token usage
- **caveman** — Ultra-compressed communication (~75% less tokens)

### 2. Add MCPs (Model Context Protocols)

```bash
/mcp add gemini-cli mobile-mcp
```

**What these MCPs do:**
- **gemini-cli** — Google Gemini AI capabilities
- **mobile-mcp** — Mobile development & testing tools

### 3. Verify Setup

```bash
/env
# Shows: MCPs, plugins, LSPs, agents, skills loaded
```

```bash
/plugin list
# Shows: All installed plugins and status
```

### 4. Build the Project

```bash
pnpm install
pnpm build
```

## Project Structure

```
swiss-shopping-mcp/
├── CLAUDE.md              ← Development context (read first!)
├── .mcp.json              ← MCP configuration reference
├── SETUP-COPILOT-CLI.md   ← This file
├── .claude/
│   ├── PLAN.md            ← Detailed roadmap
│   ├── IMPLEMENTATION_TRACKER.md  ← Current phase & checklist
├── src/
│   ├── index.ts           ← MCP server entry point
│   ├── adapters/          ← Chain adapters (Migros, Coop, etc.)
│   ├── services/          ← Business logic
│   ├── tools/             ← MCP tool handlers
│   └── util/              ← Utilities & helpers
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Development Workflow

### Launch Copilot CLI in This Project

```bash
cd /path/to/swiss-shopping-mcp
copilot
```

### With Experimental Features

```bash
copilot --experimental
```

Enables:
- **Autopilot mode** (Shift+Tab to toggle)
- Other experimental features

### Common Commands

```bash
/help                     # Show all commands
/mcp                      # Manage MCPs
/plugin                   # Manage plugins
/env                      # Show loaded environment
/lsp                      # Configure language servers
/model                    # Switch AI model
/skills                   # Manage skills
/plan                     # Create implementation plan
/research                 # Run deep research
```

### Building & Testing in Copilot

```bash
! pnpm build              # Run in shell
! pnpm test               # Run tests
! pnpm lint               # Check quality
! pnpm format             # Auto-format
```

## Troubleshooting

### Plugins Not Loading

1. Check plugin status:
   ```bash
   /plugin list
   ```

2. Restart Copilot:
   ```bash
   /restart
   ```

3. Check permissions:
   ```bash
   /allow-all
   # or: /add-dir .
   ```

### MCP Not Connecting

1. Verify build:
   ```bash
   ! pnpm build
   ```

2. Check MCP logs:
   ```bash
   /env  # Shows MCP status
   ```

3. Rebuild & reconnect:
   ```bash
   ! pnpm build
   /restart
   ```

### Token Usage High

Enable caveman mode for reduced token usage:
```bash
/caveman full
```

Or use context-mode and token-optimizer plugins (already configured).

## Configuration Files Location

- **User config**: `~/.copilot/config.json`
- **LSP config**: `~/.copilot/lsp-config.json`
- **Project instructions**: `CLAUDE.md` (automatically loaded)
- **MCP reference**: `.mcp.json` (in this project, for documentation)

## Advanced: Manual MCP Setup

If `/mcp` commands don't work, edit `~/.copilot/config.json`:

```json
{
  "mcpServers": {
    "swiss-shopping-mcp": {
      "command": "node",
      "args": ["/path/to/swiss-shopping-mcp/dist/index.js"],
      "env": {
        "LOG_LEVEL": "info"
      }
    },
    "gemini-cli": {
      "command": "gemini-cli"
    },
    "mobile-mcp": {
      "command": "mobile-mcp"
    }
  }
}
```

Then restart Copilot:
```bash
/restart
```

## Next Steps

1. ✅ Install plugins and MCPs
2. 📖 Read `CLAUDE.md` for project overview
3. 📋 Check `.claude/PLAN.md` for roadmap
4. 🏗️ Review `.claude/IMPLEMENTATION_TRACKER.md` for current phase
5. 🧪 Run tests: `! pnpm test`
6. 💻 Start coding!

## References

- [Copilot CLI Docs](https://github.com/github/gh-copilot)
- [MCP Specification](https://modelcontextprotocol.io/)
- [Project Plan](./.claude/PLAN.md)
