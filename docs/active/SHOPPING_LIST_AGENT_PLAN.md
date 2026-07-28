# Shopping List Enricher / Grounded Resolution Agent — Implementation Plan

Date: 2026-07-28
Status: planned; reviewed with antigravity-mcp (gemini-3.6-flash), not yet implemented
Superseding note (2026-07-28, same day): the owner clarified this is not a
standalone form-based PWA feature — it's one capability inside a general chat
agent. See `docs/active/CHAT_AGENT_ARCHITECTURE_PLAN.md` for the agent loop,
tool-reuse mechanism (`listTools()`/`executeToolCall()`), and chat-specific
concerns (streaming, session state, general grounding discipline). Everything
below about the resolution pipeline, status contract, store-optimizer, and
quantity parsing is unchanged and still applies — it's just invoked by the
chat agent as a capability rather than surfaced as its own tab/form.

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

**Conclusion: batch, don't loop.** The pipeline below uses zero *dedicated*
LLM calls for list parsing (deterministic pre-pass) plus however many steps
the surrounding chat agent's own turn takes to reason over the retrieved
candidates — regardless of list length (up to a practical context budget —
20 items × ~5 candidates each is roughly 8k tokens, well inside the chosen
model's context window).

## Architecture (superseded/simplified by the chat-agent decision)

The original design below was a standalone 2-LLM-call pipeline (dedicated
parser model + dedicated matcher model), designed before the owner clarified
this runs inside the general chat agent. Now that it does, the "matcher"
role collapses into the chat agent's own turn — there's no need for a
*separate* dedicated ranking model call, since the already-decided chat
model (`openai/gpt-oss-20b:free` primary, per
`CHAT_AGENT_ARCHITECTURE_PLAN.md`) is already the reasoning model present in
that turn, with the retrieved candidates available to it as tool results.

```
Raw list text (a chat message that looks like a list)
     │
     ▼
[Deterministic list-detection + parsing — 0 LLM calls]
     │  regex/heuristic pre-pass (see "Quantity parsing traps" below):
     │  splits into N structured lines: { quantity, unit, searchText }
     ▼
[Local batch retrieval — 0 LLM calls]
     │  reuses existing SearchService.searchProducts / CatalogService FTS5
     │  per line, across all requested chains — this IS the RAG retrieval
     │  step: real vendor data, not model knowledge; fired as parallel tool
     │  calls before/within the chat agent's own turn
     ▼
[Chat agent's own turn ranks/selects — uses the already-decided chat model]
     │  receives { line, candidates[] } for all N lines already resolved by
     │  the pre-pass; selects/ranks ONLY from given candidates — must never
     │  emit a product id it wasn't given; applies the status contract below
     ▼
[Deterministic store-optimizer — 0 LLM calls]
     │  pure arithmetic over resolved candidates + availability data
     ▼
EnrichedShoppingListResult
```

### Why the parsing pre-pass has no dedicated LLM call

- **List detection/splitting is regex/heuristic, not LLM-driven** — the
  quantity-parsing traps below (count-multiplier vs. target size, unit
  normalization, loose-weight items) are exactly the kind of structured,
  bounded parsing a deterministic parser handles reliably; spending a model
  call on it would add latency/budget for a task that doesn't need judgment.
- **Retrieval is always deterministic** (existing search/catalog code) —
  this is the RAG grounding step, unchanged.
- **Ranking/matching now happens for free inside the chat agent's normal
  turn** — no separate model call needed, since the chat agent already has
  to reason over tool results as part of driving the conversation.
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

## Backend / model choice (resolved — see CHAT_AGENT_ARCHITECTURE_PLAN.md)

No separate model choice needed for this feature: it runs inside the
already-decided chat agent (primary `openai/gpt-oss-20b:free`, fallback
`nvidia/nemotron-3-ultra-550b-a55b:free`, via OpenRouter's model array) —
see that doc's "Model choice" section for the full research trail
(Tau-Bench/PinchBench/SWEBench numbers, why BFCL's actual leaderboard leader
is unreachable under the $0 constraint, why the smaller model is primary
despite the lower benchmark ceiling).

The account-funding question is resolved too: `OPENROUTER_API_KEY` is
confirmed present and funded (1000 req/day cap applies) — see the "Open
items" note below.

## MCP / API surface

- Primary path (revised): this capability is invoked by the PWA chat agent
  (see `CHAT_AGENT_ARCHITECTURE_PLAN.md`) as part of its normal tool-calling
  loop over the existing 8 MCP tools, not as a dedicated new endpoint the
  PWA calls directly. Still worth exposing as one more MCP tool
  (`enrich_shopping_list`) in `listTools()`/`executeToolCall()` for external
  MCP callers (Claude Desktop etc.) that want the batched/deterministic
  version directly rather than driving the chat loop themselves.
- Whichever LLM calls this pipeline needs (parser + batch matcher, or the
  chat agent itself) require their **own** outbound API key/account
  (`OPENROUTER_API_KEY`, already confirmed present and funded — see
  [[search-provider-keys-user-scope]]), separate from `antigravity-mcp`'s
  credential. `CLAUDE.md` scopes `antigravity-mcp` as dev-only tooling
  explicitly barred from the deployed app's runtime ("no runtime/business
  MCPs in this repo config"); reusing it here would violate that, not just
  be untidy.
- Runtime risk specific to calling an LLM from inside a tool/agent handler:
  MCP clients (and this app's own chat loop) enforce their own timeouts.
  Wrap each outbound model call in a bounded `AbortController` timeout; a
  timeout or rate-limit response must resolve to `status: 'DEGRADED'` with a
  top raw FTS/taxonomy match attached, never a thrown error or a hung call.

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
   (rotates over time) — the specific model IDs are a 2026-07-28 snapshot,
   not a guarantee.
3. ~~Decide the PWA surface~~ — resolved 2026-07-28: this is invoked through
   the new chat agent tab (`CHAT_AGENT_ARCHITECTURE_PLAN.md`), not a
   dedicated shopping-list form/tab.
4. ~~Confirm minimum test coverage expectations~~ — resolved 2026-07-28: see
   `CHAT_AGENT_ARCHITECTURE_PLAN.md`'s "Testing" section
   (`MockLanguageModelV3` default suite + one opt-in live smoke test); the
   deterministic list-detection/parsing pre-pass and store-optimizer here
   get ordinary unit tests same as any other service in this repo, no
   mocking needed since they have no LLM call of their own.
