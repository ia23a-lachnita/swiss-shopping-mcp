# swiss-shopping-mcp - Development Context

**FIRST THING: Read `.claude/IMPLEMENTATION_TRACKER.md`** — it contains the current phase, completed work, and next steps.

*Then read `.claude/PLAN.md`* — detailed roadmap and success criteria.

## Project Overview

**swiss-shopping-mcp** is an enhanced Model Context Protocol (MCP) server for Swiss grocery and retail shopping. It's a production-grade evolution of the open-source swissgroceries-mcp project with improvements in reliability, feature coverage, and an architecture designed for account integration.

## Vision & Phases

### V1 (Current Focus)
Enhanced version of swissgroceries-mcp with:
- Multi-chain support (Migros, Coop, Aldi, Denner, Lidl, Farmy, Volg, Otto's)
- Cross-chain price comparison
- Smart shopping strategies
- Nutrition & allergen filtering
- Improved testing & architecture
- **Target**: 80%+ test coverage, NPM-publishable

### V2 (Next Phase)
Account integration across all chains:
- Authenticated baskets for Migros, Coop, Denner, Lidl
- Loyalty program integration (Cumulus, etc.)
- Order history & personalized deals
- Save preferences per user
- **Target**: ≥3 chains with account support

### V3+ (Roadmap)
- Expansion beyond groceries (pharma, hardware, drugstores)
- Price history tracking
- Meal planning integration
- Sustainability tracking

## Copilot CLI Configuration

### MCP Setup
This project is configured to work with Copilot CLI. MCPs and plugins are managed via:
- `/mcp` — Manage MCP server configuration in Copilot CLI
- `/plugin` — Manage plugins and plugin marketplaces in Copilot CLI

Plugins configured for this project:
- **claude-mem** — Enhanced memory management
- **context-mode** — Context window optimization
- **context7** — Advanced context handling
- **firebase** — Firebase integration
- **superpowers** — Enhanced capabilities
- **token-optimizer** — Token usage optimization
- **caveman** — Compressed communication mode

MCPs:
- **gemini-cli** — Google Gemini MCP
- **mobile-mcp** — Mobile development tools

### Installation
```bash
# From Copilot CLI interactive session:
/plugin install claude-mem context-mode context7 firebase superpowers token-optimizer caveman
/mcp add gemini-cli mobile-mcp
```

See `.mcp.json` for the intended MCP configuration schema.

## Tool / Skill Trigger Table

Before starting implementation, check which tool/skill applies:

| Task | Action |
|------|--------|
| TypeScript/Node.js implementation | Start coding directly with TypeScript strict mode |
| Testing & coverage | Use `pnpm test` / Vitest — no special skills needed |
| MCP-specific issues | Check MCP SDK docs, use @modelcontextprotocol/sdk directly |
| Architecture decisions | Review `.claude/PLAN.md` first, then code |
| Parallel adapter implementations | Consider using an `explore` agent to research multiple chains in parallel |
| Complex multi-step workflows | Use internal planning, write to `.claude/PLAN.md` |

## Tech Stack

- **Language**: TypeScript (strict mode required)
- **Package Manager**: pnpm
- **Runtime**: Node.js 18+
- **Testing**: Vitest with coverage
- **Linting**: ESLint + Prettier
- **MCP SDK**: @modelcontextprotocol/sdk
- **License**: MIT

## Key Files

- `.claude/PLAN.md` - **READ THIS FIRST** — roadmap & success criteria
- `CLAUDE.md` - This file (architecture & dev notes)
- `.mcp.json` - MCP configuration schema
- `src/index.ts` - MCP server entry point
- `src/adapters/types.ts` - Common types for all chain adapters
- `src/adapters/` - Individual chain implementations (Migros, Coop, etc.)
- `src/services/` - Core business logic (matcher, planner, strategy)
- `src/tools/` - MCP tool handlers
- `src/util/` - Utilities (logging, HTTP, geocoding)
- `package.json` - Dependencies & scripts

## Development Workflow

### Setup
```bash
pnpm install
pnpm build
```

### Development Loop
```bash
pnpm watch        # TypeScript watch mode in background
pnpm test --ui    # Interactive test UI
pnpm format       # Auto-format code
pnpm lint         # Check quality
```

### Testing
```bash
pnpm test               # Run all tests
pnpm test:ui           # Interactive UI
pnpm test:coverage     # Coverage report (target: 80%+)
```

### Quality Gates
```bash
pnpm format  # Must pass before commit
pnpm lint    # Must have no errors
pnpm test    # Must pass (new features require tests)
```

## Architecture

### Adapter Pattern
Each chain (Migros, Coop, Aldi, etc.) has its own adapter:
- Implements chain-specific API logic
- Normalizes responses to `NormalizedProduct`, `NormalizedStore`, `NormalizedPromotion`
- Handles authentication (V2)
- Returns `Result<T>` for error handling

### Normalization
All adapters produce standardized types so the system is chain-agnostic:
- `NormalizedProduct` — common price, nutrition, allergens
- `NormalizedStore` — location, hours, chain
- `NormalizedPromotion` — discount, validity, applicable stores

### Services (Core Logic)
- **Matcher** — maps user queries to canonical products (avoid false positives like Apfelschorle for "apfel")
- **Planner** — multi-chain optimizer (parallel search, geo-filtering)
- **Strategy** — shopping plan solver (single-store, split-cart, absolute cheapest)

### Account Support (V2)
- Optional OAuth/session authentication
- Credentials stored in OS keychain (secure)
- Token refresh automatic
- Graceful fallback to anonymous mode if auth fails

## Testing Strategy

- **Unit tests**: Adapters, utilities, services (isolated)
- **Integration tests**: Multi-chain scenarios, planner, strategy
- **Snapshot tests**: API response normalization
- **E2E tests**: Full shopping workflows (future)
- **Target**: 80%+ coverage minimum

## Common Tasks

### Adding a Chain Adapter
1. Create `src/adapters/[chain]/index.ts`
2. Implement API client & authentication (if needed)
3. Implement methods: `searchProducts()`, `searchStores()`, `getPromotion()`, etc.
4. Normalize responses to common types
5. Add unit tests with mocked API responses
6. Test against real API (optional, rate-limit aware)

### Adding a New Tool
1. Create `src/tools/my_tool.ts`
2. Define Zod schema for inputs
3. Implement handler: `(registry, args) => Promise<Result>`
4. Register in `src/index.ts` ListToolsRequestSchema handler
5. Add tests in `my_tool.test.ts`

### Adding Authentication (V2)
1. Create `src/auth/[chain]_auth.ts`
2. Implement OAuth/session login
3. Store tokens in OS keychain (via node-keytar)
4. Add token refresh logic
5. Handle credential expiry gracefully
6. Test session persistence across restarts

## Code Standards

- **TypeScript**: Strict mode required, all types explicit
- **Tests**: Required for new features, aim for 80%+ coverage
- **Formatting**: Run `pnpm format` before commit
- **Linting**: No errors allowed, fix with `pnpm lint --fix`
- **Commits**: Descriptive messages, reference PLAN.md phase if applicable
- **Comments**: Only for non-obvious logic, not obvious code

## Related Projects

- [swissgroceries-mcp](https://github.com/nicktcode/swissgroceries-mcp) — Original (AGPL-3.0)
- [migros-mcp](https://github.com/lewpgs/migros-mcp) — Migros + account (MIT)
