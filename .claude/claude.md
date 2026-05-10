# swiss-shopping-mcp - Development Context

## Project Overview

**swiss-shopping-mcp** is an enhanced Model Context Protocol (MCP) server for Swiss grocery and retail shopping. It's a production-grade evolution of the open-source swissgroceries-mcp project with improvements in reliability, feature coverage, and an architecture designed for account integration.

## Vision

### V1 (Current)
Enhanced version of swissgroceries-mcp with:
- Multi-chain support (Migros, Coop, Aldi, Denner, Lidl, Farmy, Volg, Otto's)
- Cross-chain price comparison
- Smart shopping strategies
- Nutrition & allergen filtering
- Improved testing & architecture

### V2 (Planned)
Account integration across all chains:
- Authenticated baskets for Migros, Coop, Denner, Lidl
- Loyalty program integration (Cumulus, etc.)
- Order history & personalized deals
- Save preferences per user

### V3+ (Roadmap)
- Expansion beyond groceries (pharma, hardware, drugstores)
- Price history tracking
- Meal planning integration
- Sustainability tracking

## Tech Stack

- **Language**: TypeScript
- **Package Manager**: pnpm
- **Runtime**: Node.js 18+
- **Testing**: Vitest
- **Linting**: ESLint + Prettier
- **MCP SDK**: @modelcontextprotocol/sdk

## Key Files

- `src/index.ts` - MCP server entry point
- `src/adapters/types.ts` - Common types for all chain adapters
- `src/adapters/` - Individual chain implementations (future)
- `src/services/` - Core business logic (matching, planning, strategy)
- `src/tools/` - MCP tool handlers
- `src/util/` - Utilities (logging, HTTP, geocoding)

## Development Workflow

1. **Setup**
   ```bash
   pnpm install
   pnpm build
   ```

2. **Development**
   ```bash
   pnpm watch    # TypeScript watch mode
   pnpm dev      # Build and run
   ```

3. **Testing**
   ```bash
   pnpm test           # Run tests
   pnpm test:ui        # Interactive UI
   pnpm test:coverage  # Coverage report
   ```

4. **Quality**
   ```bash
   pnpm lint     # ESLint
   pnpm format   # Prettier
   ```

## Architecture Notes

### Adapter Pattern
Each chain (Migros, Coop, Aldi, etc.) has its own adapter that:
- Implements chain-specific API logic
- Normalizes responses to common types
- Handles authentication (when needed)

### Normalization
All adapters produce standardized `NormalizedProduct`, `NormalizedStore`, and `NormalizedPromotion` types so the rest of the system is chain-agnostic.

### Account Support (V2)
- Optional OAuth/session authentication
- Store credentials securely in OS keychain
- Refresh tokens automatically
- Graceful fallback to anonymous mode

## Testing Strategy

- **Unit tests**: Individual adapters, utilities, and services
- **Integration tests**: Multi-chain scenarios
- **Snapshot tests**: API response normalization
- **E2E tests**: Full shopping plan workflows (future)

## Common Tasks

### Adding a New Tool
1. Create `src/tools/my_tool.ts`
2. Define Zod schema for inputs
3. Implement handler function
4. Register in `src/index.ts`
5. Add tests in `my_tool.test.ts`

### Adding a New Chain Adapter
1. Create `src/adapters/[chain]/index.ts`
2. Implement required interface methods
3. Add API client wrapper
4. Normalize responses
5. Add tests

### Handling Authentication (V2)
1. Create `src/auth/[chain]_auth.ts`
2. Implement login/token refresh logic
3. Store in OS keychain
4. Test session persistence

## Notes

- All code must be TypeScript with strict mode enabled
- Tests required for new features
- Maintain 80%+ coverage target
- Follow prettier/eslint rules
- Use descriptive commit messages

## Related Projects

- [swissgroceries-mcp](https://github.com/nicktcode/swissgroceries-mcp) - Original project (AGPL-3.0)
- [migros-mcp](https://github.com/lewpgs/migros-mcp) - Migros-specific implementation with account support
