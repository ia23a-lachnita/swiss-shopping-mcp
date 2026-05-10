# swiss-shopping-mcp

An advanced Model Context Protocol (MCP) server for Swiss grocery and retail shopping with multi-chain price comparison, smart purchasing strategies, and optional account integration.

## Features

### V1 (Enhanced swissgroceries-mcp)
- **Multi-chain support**: Migros, Coop, Aldi, Denner, Lidl, Farmy, Volg, Otto's
- **Price comparison**: Cross-chain unit pricing, promotion tracking
- **Smart planning**: Single-store, split-cart, and cost-optimized shopping strategies
- **Nutrition filtering**: Standardized nutrition data across chains
- **Allergen & dietary**: Vegan, vegetarian, gluten-free, and more
- **Store locator**: Find nearby stores with opening hours

### V2 (Account Integration)
- **Authenticated cart**: Add/remove items from multiple store baskets
- **Loyalty programs**: Cumulus (Migros), Coop, Denner loyalty integration
- **Order history**: Track spending and purchase patterns
- **Personalized deals**: Account-specific promotions and rewards

### V3+ (Expansion)
- **Beyond groceries**: Pharmacies, drugstores, hardware stores
- **Price history**: Track trends and get notifications
- **Meal planning**: Recipe integration and bulk buying optimization
- **Sustainability**: Carbon footprint tracking

## Installation

### Prerequisites
- Node.js 18+
- pnpm (or npm/yarn)

### Setup
```bash
pnpm install
pnpm build
pnpm dev
```

### Testing
```bash
pnpm test          # Run tests
pnpm test:ui       # Interactive UI
pnpm test:coverage # Coverage report
```

## Development

```bash
pnpm watch         # Watch TypeScript
pnpm lint          # ESLint
pnpm format        # Prettier
```

## Architecture

```
src/
├── adapters/       # Chain-specific integrations (Migros, Coop, etc.)
├── services/       # Core business logic (matching, planning, strategy)
├── tools/          # MCP tool handlers
├── util/           # Utilities (logging, geocoding, HTTP)
└── index.ts        # MCP server entry point
```

## Contributing

Contributions welcome! Please:
1. Add tests for new features
2. Follow TypeScript strict mode
3. Use prettier/eslint format
4. Update README for new tools

## License

MIT

## Roadmap

- [ ] V1: Enhanced multi-chain shopping (copy from swissgroceries-mcp with improvements)
- [ ] V2: Account integration across all supported chains
- [ ] V3: Non-grocery expansion (pharma, hardware, etc.)
- [ ] V3+: Price history, meal planning, sustainability tracking
