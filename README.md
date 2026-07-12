# swiss-shopping-mcp

A Model Context Protocol (MCP) server for Swiss grocery and retail shopping — price comparison, promotions, and store discovery across supported Swiss chains.

> **Data trust policy:** This server does not return demo or invented grocery data in default runtime.
> If a source is missing, blocked, or degraded, tools return explicit source warnings or errors.
> Call `get_source_status` to see current capability support before using other tools.

## Source Support Matrix

| Chain  | Product Search | Promotions  | Store Search | Availability |
|--------|----------------|-------------|--------------|--------------|
| Migros | live-beta      | unsupported | live-beta    | live-beta    |
| Coop   | live-beta      | unsupported | live-beta    | live-beta    |
| Aldi   | live-beta      | unsupported | unsupported  | live-beta    |
| Denner | live-beta      | live-beta   | unsupported  | unsupported  |
| Lidl   | live-beta      | unsupported | live-beta    | unsupported  |
| Volg   | live-beta      | unsupported | live-beta    | unsupported  |
| Otto's | live-beta      | unsupported | live-beta    | unsupported  |

Status meanings:
- **live-beta** — real source, tested, may break on upstream changes
- **source-auditing** — feasibility under review, not yet implemented
- **blocked** — source audited and found unsuitable or ceased
- **unsupported** — no source planned yet

Farmy was removed entirely: the retailer has ceased operations.

## Requirements

- Node.js 20+
- npm (pnpm has compatibility issues with Node 20.20.0 + corepack)

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_source_status` | Capability status matrix for all chains — start here |
| `search_products` | Search products (Aldi live-beta, others unsupported) |
| `search_promotions` | Search current promotions (Denner live-beta, others unsupported) |
| `find_stores` | Find stores by location (all chains currently unsupported) |
| `compare_prices` | Cross-chain price comparison (source-backed chains only) |
| `get_store_availability_support` | Per-chain store availability support |
| `lookup_store_product_availability` | Product availability in a specific store |

## Installation

```bash
npm install
npm run build
```

## Running

```bash
node dist/index.js
```

Or configure in your MCP client's settings:

```json
{
  "mcpServers": {
    "swiss-shopping": {
      "command": "node",
      "args": ["/path/to/swiss-shopping-mcp/dist/index.js"]
    }
  }
}
```

## Configuration

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `SWISS_SHOPPING_WEB_SEARCH` | `auto` | Semantic web-augmented product search: `auto` (Google when keys are set, otherwise DuckDuckGo), `google`, `ddg`, or `off`. |
| `GOOGLE_CSE_API_KEY` | — | Google Programmable Search API key (recommended: 100 free queries/day; far more reliable than the keyless DuckDuckGo fallback, which rate-limits bursts). |
| `GOOGLE_CSE_CX` | — | Google Programmable Search engine ID (`cx`). Create one at https://programmablesearchengine.google.com with "Search the entire web" enabled. |
| `SWISS_SHOPPING_CACHE_DIR` | OS temp dir | Directory for the file TTL cache. |

Web-augmented search issues site-restricted engine queries (e.g. `site:migros.ch/de/product zahncreme empfindliche zaehne`), extracts product IDs from the ranked result URLs, and hydrates full product data through the vendor detail APIs (currently Migros and Coop). It fixes the semantic gap of literal vendor search — English or paraphrased queries like "toothpaste for sensitive teeth" return products instead of zero results. Engine failures degrade gracefully to vendor-only results with a source warning.

## Development

```bash
npm test          # Run tests
npm run lint      # ESLint
npm run build     # TypeScript compile
npm run test:live # Opt-in live source smoke tests (requires LIVE_SOURCE_TESTS=1)
```

## Architecture

```
src/
├── adapters/           # Chain-specific adapters
│   ├── index.ts        # Default adapter factory (live adapters + UnsupportedChainAdapter)
│   ├── sourceRegistry.ts  # Per-chain per-capability status matrix
│   ├── unsupportedAdapter.ts  # Explicit unsupported adapter (replaces static catalog)
│   ├── live/           # Live-beta adapters (Aldi, Denner)
│   └── types.ts        # Domain model: NormalizedProduct, NormalizedStore, etc.
├── services/           # Core logic (search fan-out, price comparison)
├── sources/            # HTTP client, source warnings
├── parsers/            # HTML/XML parsers for live sources
├── cache/              # File-based TTL cache
├── tools/              # MCP tool schemas and handlers
└── util/               # Matching, units, logging
```

## Data Architecture Decisions

- **No static catalog** in production runtime. All product/store/promotion data comes from real sources or returns explicit unsupported errors.
- **Aldi product search** uses a live-beta sitemap + product-page scraping path. Cold-cache latency applies; recall is limited to sitemap-indexed products.
- **Denner promotions** fetches the live promotions page with a 6-hour file cache.
- **All other chains** return `REAL_SOURCE_NOT_IMPLEMENTED` until a provider, API, or maintained index is selected. See `docs/active/SOURCE_PROVIDER_DECISION_RECORD.md`.

## License

MIT
