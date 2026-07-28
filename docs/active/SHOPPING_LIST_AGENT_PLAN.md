# Shopping List Enricher / Grounded Resolution Agent — Implementation Plan

Date: 2026-07-28
Status: planned; reviewed with antigravity-mcp (gemini-3.6-flash), not yet implemented

## Goal

Let a user paste/upload a free-text shopping list (e.g. `"2x Milch / Zahnpasta
sensitive / 500g Rindshackfleisch / Reis Basmati 1kg"`) and get back, per line:
a resolved real product + price per available chain, and an overall
recommendation for where to shop (single store, split across two stores, or a
cheapest-regardless-of-location baseline).

This is the design fleshed out from tracker "Next tasks" item 5 ("shopping-
list/wishlist ... NOT automated login/checkout", previously unscoped). It
supersedes nothing; `CLAUDE.md`'s checkout/cart exclusion still applies
unchanged — this only ever produces a list + "here's where to buy it", never
an automated purchase.

The project owner explicitly wants this built as a **RAG agent, with tools,
grounded answers, an explicit low-confidence status (never silent guessing),
optionally multi-agent, running on a $0 LLM backend** (Gemini free tier or an
OpenRouter free model) — this supersedes the earlier deterministic-only
recommendation from the first design pass. See "Decisions" below for why the
final shape isn't "1 LLM call per line item", which the free-tier numbers
rule out.

## Non-goals

- No automated login/cart/checkout against any vendor account (unchanged
  `CLAUDE.md` exclusion).
- No web-search grounding (Google's or anyone else's) — grounding source is
  this project's own already-built vendor data (`search_products`, catalog
  FTS5), not the open internet. The list-resolution LLM must select/rank only
  from real tool-returned candidates and is explicitly barred from inventing
  a product that wasn't retrieved.
- No paid LLM API. If free-tier capacity genuinely can't cover real usage,
  that's a decision to surface back to the owner, not something to
  quietly work around with a paid key.

## Why not "1 LLM call per line item"

Live-checked (2026-07-28) free-tier numbers, not blog estimates:

- **OpenRouter** (`:free`-suffixed models): 20 requests/minute platform-wide
  across all free models, and a daily cap of 50 requests/day unless the
  account has ever deposited $10+ credit (then 1000/day — still $0 per-token,
  the $10 is a one-time unlock). A single 20-item list at 1 call/item already
  exceeds the per-minute cap outright (guaranteed 429 around item #19-20) and
  burns 40%+ of the *unfunded* daily quota in one request.
- **Gemini direct API free tier**: even tighter, 5-15 RPM depending on model
  (Gemini 2.5 Pro is 5 RPM). Function calling is a real free-tier feature
  (not billing-gated); Google's own "search grounding" tool is separately
  capped at 5,000 prompts/month shared across the whole Gemini 3 family — but
  that's grounding against the open web, not what this feature needs anyway.
- Confirmed live via `openrouter.ai/api/v1/models`: 17 free models exist
  today, 14 support tool calling, including
  `nvidia/nemotron-3-ultra-550b-a55b:free` (550B MoE, 1M ctx, described by
  NVIDIA itself as an "orchestration model"),
  `nvidia/nemotron-3-super-120b-a12b:free` (262K ctx),
  `nvidia/nemotron-3-nano-30b-a3b:free` (256K ctx, cheap/fast),
  `google/gemma-4-31b-it:free` (262K ctx, dense multimodal), and
  `openai/gpt-oss-20b:free` (131K ctx, open-weight). This list rotates as
  providers add/pull free models — re-check before implementation, don't
  hardcode trust in these exact IDs surviving to build time.

**Conclusion: batch, don't loop.** The pipeline below uses exactly 2 LLM
calls per list submission, regardless of list length (up to a practical
context budget — 20 items × ~5 candidates each is roughly 8k tokens, well
inside every free model's context window above).

## Architecture

```
Raw list text
     │
     ▼
[LLM Call #1 — Parser/Extractor]     (fast/cheap free model)
     │  splits into N structured lines: { quantity, unit, searchText }
     │  tolerates German/French/Italian/English input, "2x", "500g", etc.
     ▼
[Local batch retrieval — 0 LLM calls]
     │  reuses existing SearchService.searchProducts / CatalogService FTS5
     │  per line, across all requested chains — this IS the RAG retrieval
     │  step: real vendor data, not model knowledge
     ▼
[LLM Call #2 — Batch Matcher/Ranker]  (larger/more careful free model)
     │  receives { line, candidates[] } for ALL N lines in one call
     │  selects/ranks ONLY from the given candidates — must never emit a
     │  product id it wasn't given
     ▼
[Deterministic store-optimizer — 0 LLM calls]
     │  pure arithmetic over resolved candidates + availability data
     ▼
EnrichedShoppingListResult
```

### Why two agents, not one

- **Parser** needs to handle messy, multilingual, shorthand input — a small
  fast model is enough and keeps latency down on the interactive path.
- **Matcher** needs more careful judgment (is "Vollmilch UHT 3.5%" really the
  best match for a bare "Milch"?) across the *whole* list at once, so a
  larger/more careful free model is worth spending the second call on.
- **Store-optimizer stays 100% deterministic** — there's no ambiguity left to
  resolve once products are matched; running an LLM over arithmetic would add
  risk (and API budget) for zero benefit.

### Status contract (the explicit "not good" surfacing the owner asked for)

```typescript
type MatchStatus = 'RESOLVED' | 'AMBIGUOUS' | 'UNRESOLVED' | 'DEGRADED';

interface EnrichedItemResult {
  rawInput: string;
  quantity: { count: number; size?: { value: number; unit: string } };
  status: MatchStatus;
  selectedProductId: string | null;
  confidence: number; // 0.0–1.0, only meaningful for RESOLVED/AMBIGUOUS
  candidates: Array<{ chain: Chain; productId: string; name: string; price: number }>;
  reasoning?: string; // short human-readable "why", e.g. "multiple 1L milk brands, no brand specified"
}
```

| Status | Meaning | Never |
| --- | --- | --- |
| `RESOLVED` | One candidate clearly best (confidence > 0.8) | — |
| `AMBIGUOUS` | Multiple plausible candidates, comparable confidence | auto-picking one silently |
| `UNRESOLVED` | No candidate cleared the minimum threshold, or retrieval returned nothing | inventing a product |
| `DEGRADED` | The LLM call itself failed/timed out/rate-limited/returned invalid JSON | crashing the tool call — falls back to the top raw FTS/taxonomy match with this flag set |

`DEGRADED` is the failure-mode status: an LLM outage must never crash
`enrich_shopping_list` or silently look identical to a confident match — the
distinction between "we couldn't ask the model" and "the model looked and
found nothing good" must survive to the caller.

### Store recommendation (deterministic, unchanged from the original pass)

For each nearby Migros/Coop store (only chains with real per-store stock
data — reuses `lookupStoreProductAvailability`/`findStores`), score:
`in_stock_count` desc → `distance_km` asc → `total_cost` asc. If no single
store covers the full list, fall back to the best 2-store split among nearby
pairs, and say so explicitly ("no single store has everything; best split:
Migros X (8/10 items) + Coop Y (2/10)") rather than presenting a
falsely-complete answer. Other chains (Aldi/Denner/Lidl/Volg/Otto's)
contribute price/catalog matches only, always labeled "sold here, stock not
verifiable" — never blended into the "confirmed in stock" count.

## Backend / model choice

- **Default to OpenRouter over direct Gemini** for this feature specifically:
  OpenRouter supports a fallback model array in one request (try model A,
  auto-retry model B on 429/error) — direct Gemini has no equivalent
  automatic routing across models.
- Suggested pipeline default: parser call → `openai/gpt-oss-20b:free` or
  `nvidia/nemotron-3-nano-30b-a3b:free`; matcher call →
  `google/gemma-4-31b-it:free` (multilingual, relevant for Swiss
  German/French/Italian product names) with
  `nvidia/nemotron-3-super-120b-a12b:free` as the fallback.
- **The $10 one-time OpenRouter credit deposit is worth explicitly
  recommending to the owner**: unfunded, the app-wide cap is 50 req/day = ~25
  list-enrichments/day total (2 calls/list) for *all* users combined; funded,
  it's 1000 req/day = ~500 list-enrichments/day, still $0 per-token. This is
  a real product decision, not an implementation detail — flag it, don't
  silently assume the $10 is fine to spend.
- Model IDs above are today's free-tier snapshot (checked 2026-07-28 against
  `openrouter.ai/api/v1/models`) — OpenRouter's free lineup rotates as
  providers add/retire promotional models; re-verify against the live API
  response immediately before implementation rather than trusting this doc.

## MCP / API surface

- New MCP tool `enrich_shopping_list` (agent-composable) sharing one backing
  `ListEnricherService` with a new PWA HTTP endpoint — a calling agent
  looping `search_products` manually per line itself would burn far more
  tokens/latency than one batched call, and risks the calling agent dropping
  or miscounting items across many round trips.
- The LLM calls live *inside* this tool's handler (a genuine "agentic tool
  wrapper" pattern) — this needs its **own** outbound API key/account,
  separate from `antigravity-mcp`'s credential. `CLAUDE.md` already scopes
  `antigravity-mcp` as dev-only tooling explicitly barred from the deployed
  app's runtime ("no runtime/business MCPs in this repo config"); reusing it
  here would violate that, not just be untidy.
- Runtime risk specific to calling an LLM from inside an MCP tool handler:
  MCP clients enforce their own RPC timeouts (often 30-60s). Wrap each
  outbound model call in a ~10s `AbortController` timeout; a timeout or
  rate-limit response must resolve to `status: 'DEGRADED'` with a top raw
  FTS/taxonomy match attached, never a thrown error or a hung tool call.

## Quantity parsing traps (flagged for the parser-agent's prompt/tests)

- Count-multiplier vs. target size are different axes: `"2x Milch"` (count=2,
  size unspecified), `"500g Rindshackfleisch"` (count=1, target=500g),
  `"2x 500g Rindshackfleisch"` (count=2, target=500g each, needs ×2 pricing).
- Unit normalization into canonical g/ml (kg→g, l/L/Liter→ml, dl→ml) — note
  this is a *new* small parser for user-typed quantities; it is not the same
  code path as the existing vendor-size parsers (`units.ts`, `productSize.ts`,
  which parse *vendor* pack sizes from scraped pages, not user list text).
- Loose/catch-weight items (bananas priced per kg) vs. fixed packages need
  different pricing math — scaling by weight ratio for the former, ceiling-
  divide into whole packages for the latter.
- Non-standard qualitative quantities ("Bund", "Packung", "Dose", "Flasche")
  should be stripped for the retrieval query but kept as a hint if package
  matching comes back empty.

## Open items before implementation starts

1. ~~Confirm which free-tier account(s) to actually provision~~ — resolved
   2026-07-28: `OPENROUTER_API_KEY` is already set at Windows user scope on
   the dev machine. Verified live against OpenRouter's own
   `GET /api/v1/auth/key` (not just trusted as claimed): `is_free_tier:
   false`, confirming this is a funded account — the **1000 req/day** cap on
   `:free`-suffixed models applies, not the unfunded 50/day cap. No further
   billing action needed.
2. Re-verify the live free-model list immediately before implementation
   (rotates over time) — the specific model IDs in this doc are a
   2026-07-28 snapshot, not a guarantee.
3. Decide the PWA surface: a 5th tab, or folded into an existing tab (the
   app is already at 4 tabs — Availability/Search/Compare/Status).
4. Confirm minimum test coverage expectations for the LLM-touching path
   given it's inherently non-deterministic — likely: mock the LLM calls in
   the default test suite (deterministic contract tests on the
   parse→retrieve→match→optimize plumbing), with a `DEGRADED`-path test that
   doesn't require a real API key, plus an opt-in live smoke test gated the
   same way `.live.test.ts` files already are.
