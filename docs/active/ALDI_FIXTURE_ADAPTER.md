# Aldi Fixture-Backed Adapter Slice

Date: 2026-05-18
Status: fixture-backed, not wired into production defaults

## Scope

This slice implements the first real-source parser/adapter path from
`docs/active/SOURCE_AUDIT.md`:

- `src/parsers/aldi.ts` parses Aldi product sitemap XML and product page
  schema.org JSON-LD.
- `src/adapters/live/aldiFixtureAdapter.ts` maps parsed Aldi product records to
  `NormalizedProduct`.
- `fixtures/live-sources/aldi/` stores small captured Aldi source snippets for
  deterministic parser and adapter tests.

The adapter is deliberately **not** added to `createDefaultAdapters()` yet. V1
runtime still uses static adapters until a live/cache-backed Aldi source client
is implemented and smoke-tested.

## Source Evidence

The fixture source path comes from the source audit:

- Product sitemap:
  `https://www.aldi-suisse.ch/de/sitemap_products.xml`
- Example product page:
  `https://www.aldi-suisse.ch/de/produkt/backbox-toskanabrot-000000000000101698`

The captured product page snippet includes real schema.org `Product`, `Offer`,
and `BreadcrumbList` JSON-LD observed during the audit. The full HTML response
is not stored because the parser only depends on JSON-LD and the complete page
is large and noisy.

## Implemented Behavior

| Capability | Status | Notes |
|---|---|---|
| Product sitemap parsing | done | Extracts `<loc>` and optional `<lastmod>` entries |
| Product page parsing | done | Extracts product ID, URL, name, brand, CHF price, category, image, and availability |
| Normalized product mapping | done | Adds `retailer-web` provenance with `freshness: "cached"` |
| Product search | done | Supports query, match mode, max price, category, tags, and limit |
| Store search | not implemented | Returns `REAL_SOURCE_NOT_IMPLEMENTED` |
| Store availability | not implemented | Returns unsupported metadata |
| Production runtime wiring | not implemented | Intentionally deferred until live/cache-backed source client exists |

## Test Cases

| Test file | Coverage |
|---|---|
| `src/parsers/aldi.test.ts` | Sitemap parsing, product JSON-LD parsing, explicit URL fallback, missing product JSON-LD error, invalid price error |
| `src/adapters/live/aldiFixtureAdapter.test.ts` | Search result normalization/provenance, filters, blank query validation, unsupported store/availability behavior |

## Next Step

Turn this fixture-backed path into live-beta by adding an Aldi source client that:

1. Fetches product sitemap entries with conservative rate limits.
2. Fetches selected product pages through `SourceHttpClient`.
3. Writes observations through `FileTtlCache`.
4. Returns cached/stale provenance and source warnings explicitly.
5. Adds an opt-in `*.live.test.ts` smoke test for one stable query.
