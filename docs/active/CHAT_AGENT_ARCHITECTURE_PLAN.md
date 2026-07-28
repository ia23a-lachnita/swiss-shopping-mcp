# PWA Chat Agent — Architecture Plan

Date: 2026-07-28
Status: planned; reviewed with antigravity-mcp (gemini-3.6-flash), not yet implemented

## Goal

The owner clarified the real scope after the first shopping-list design pass:
the shopping-list resolver is not a standalone form-based feature — it's one
capability of a general **AI chat interface embedded in the PWA**. The chat
agent should do everything the existing PWA tabs already do (product search,
price comparison, store finding, availability checking) plus resolve
free-text shopping lists, all via natural conversation, backed by a free
OpenRouter model with tool calling.

This doc covers the general agent-loop architecture. Shopping-list-specific
details (line-item status contract, quantity parsing, store-optimizer
algorithm) stay in `docs/active/SHOPPING_LIST_AGENT_PLAN.md` — that
resolution logic runs *inside* this agent as one capability among others, not
as its own UI surface.

## Why this is cheaper to build than it sounds

Read the actual source before designing this, not just assuming: `src/tools/handlers.ts`
already has exactly the seam this needs —

- `listTools()` returns `{name, description, inputSchema}` for all 8 existing
  MCP tools (`search_products`, `search_promotions`, `find_stores`,
  `compare_prices`, `get_store_availability_support`,
  `lookup_store_product_availability`, `get_source_status`, `get_metrics`).
  `inputSchema` is already hand-written plain JSON Schema — it drops into an
  OpenAI-style `tools: [{type:'function', function:{name, description,
  parameters}}]` array with no transformation logic.
- `executeToolCall(params: {name, arguments}, dependencies)` is a single
  exported async function that dispatches any of those 8 tools and returns a
  `CallToolResult`, already fully decoupled from the MCP stdio/SSE transport
  — callable in-process from any new HTTP route.

So the agent's tool layer is a thin wrapper over code that already exists,
not a new implementation of search/compare/availability logic. The new work
is entirely the loop, the chat surface, and the grounding/failure discipline
around it.

## Agent loop shape

```
Client POST /api/chat { messages: [...] }
        │
        ▼
┌─────────────────────────┐
│ OpenRouter chat call    │◄──────────────┐
│ tools = listTools()     │                │
│   mapped to OpenAI fmt  │                │
└───────────┬─────────────┘                │
            │                              │
      tool_calls present?                  │
        │         │                        │
        NO        YES                      │
        │         │                        │
        ▼         ▼                        │
  [ return ]  Promise.all(                  │
   final       tool_calls.map(executeToolCall)  │
   message   )  — parallel, not sequential  │
                  │                          │
                  ▼                          │
        append tool result messages ─────────┘
```

Key points from review:

- **Parallel tool execution within a round is mandatory, not optional.** All
  8 tools are pure reads (no side effects) — if a model response contains 4
  `tool_calls` in one round, running them with `Promise.all` takes the
  slowest call's time, not the sum. Sequential execution here would be a
  real, needless latency bug given how this codebase's live-vendor adapters
  already run at 1-10s each.
- **Circuit breakers are required, not optional:**
  - Hard cap on **total tool calls per HTTP request** across all rounds
    (proposed: 12) — a round cap alone doesn't stop a single wayward
    response from requesting 50 calls in round one.
  - Hard **timeout on the whole loop** (proposed: ~15s) — on timeout, force
    a final answer from whatever tool results have completed so far, rather
    than hanging the request.
  - **Truncate/normalize tool output before feeding it back to the model**
    (e.g. `{title, price, chain, availability}` only) — raw `search_products`
    payloads across several rounds will otherwise blow up context size and
    latency.

## The N+1 problem, re-examined for chat (and why it isn't automatically solved)

OpenAI-style tool calling lets one model turn emit *multiple* `tool_calls` at
once, which looked like it might dissolve the earlier "1 LLM call per list
item" rate-limit problem for free-tier models. **It doesn't, reliably, on
free models specifically:**

- Larger models (`nvidia/nemotron-3-ultra-550b-a55b:free`) handle multi-tool
  selection meaningfully better than small ones.
- Smaller/quantized free models (`google/gemma-4-31b-it:free`,
  `openai/gpt-oss-20b:free`) tend to either dribble out 2-3 tool calls per
  round and take 4+ rounds for a 10-item list (burning daily quota fast), or
  fail to keep well-formed JSON across a large `tool_calls` array, or skip
  tools and hallucinate outright.
- Even larger free models degrade past roughly 5 tool calls requested in a
  single turn.

**Mitigations, not a single fix:**

1. System-prompt directive mandating "issue ALL necessary tool calls in one
   turn, don't dribble" — necessary but not sufficient on its own.
2. **Backend pre-pass for explicit lists**: when the user's message looks
   like a list (heuristic: newlines/bullets/`"2x"`-style tokens), don't rely
   on the chat model to realize it needs N `search_products` calls — run the
   deterministic list-splitting from `SHOPPING_LIST_AGENT_PLAN.md` first,
   fan out the retrieval calls directly, and inject the results into the
   conversation context before the model's first real turn. This keeps the
   shopping-list case bounded and fast regardless of how well the chat model
   batches tool calls generically.

## Session / history state

**Client-side, not server-side.** The PWA has no auth/accounts (unchanged
`CLAUDE.md` scope) and this app is meant to degrade gracefully offline —
adding a server-side session store (TTL eviction, orphaned-session cleanup)
would be new state-management debt for no real benefit here. Store full
conversation history in the PWA (IndexedDB), resend the visible
user/assistant messages on each `POST /api/chat`; the backend stays a
stateless worker that only holds state transiently for the duration of one
request's tool-calling rounds. Don't persist intermediate tool-call messages
into the client's saved history — only the final human-readable exchange.

## Streaming

This repo already has one SSE precedent (`GET /api/search-products/stream`
for live per-chain progress) — reuse that pattern rather than inventing a
new one. A blocking POST is the simpler first cut but means the user stares
at a spinner for the whole multi-round loop (plausibly several seconds to
low tens of seconds, consistent with this app's existing live-vendor
latencies). Recommended target shape once past a first pass:

```
event: status   data: {"message": "Suche bei Migros & Coop..."}
event: status   data: {"message": "Vergleiche Preise..."}
event: delta    data: {"text": "Ich habe "}
event: delta    data: {"text": "Butter bei Migros für CHF 2.50 gefunden..."}
event: done     data: {}
```

## Grounding discipline in open-ended chat

The shopping-list feature's `RESOLVED/AMBIGUOUS/UNRESOLVED/DEGRADED` status
contract was designed for one structured task; general chat needs the same
discipline applied more broadly, because a system-prompt instruction alone
("don't invent prices") is not reliable enough against free/open-weight
models, which will readily hallucinate a plausible CHF price when a tool
call returns nothing.

Two layers, both required:

1. **Strict system-prompt rules** — only state prices/availability/stores
   that came from a tool call *in this session*; if a tool call fails or
   returns empty, say so explicitly rather than guessing; never extrapolate
   from general knowledge of Swiss grocery prices.
2. **UI-level "verified" grounding, not just trusting the model's prose** —
   the chat endpoint returns both the assistant's text *and* the structured
   tool payloads actually returned during that turn; the PWA renders those
   as distinct product/price cards under the message (reusing the existing
   `ProductSheet`/card components), so a hallucinated claim in the model's
   free text is visually distinguishable from a tool-backed fact even if the
   model's prose gets it wrong.

## Open items before implementation starts

1. Model choice for the chat loop specifically (as opposed to the earlier
   shopping-list batch-matcher choice) — needs empirical testing against
   real multi-tool-call prompts, not just picked from context-window size.
   Re-verify current free-tier model IDs against `openrouter.ai/api/v1/models`
   before implementation (rotates over time).
2. PWA surface: confirmed as a new chat tab (5th tab) per owner decision —
   not folded into an existing tab.
3. Whether the list-detection pre-pass (heuristic-triggered deterministic
   splitting before the first LLM turn) is in scope for a first version, or
   whether v1 relies on the chat model's own tool-batching with the
   mitigations above and the pre-pass is a fast-follow once real dribbling
   behavior is observed against the actual chosen model.
4. Test strategy: the agent loop's control flow (round cap, tool-call cap,
   timeout, parallel execution, tool-result truncation) is deterministic and
   testable with a mocked OpenRouter client; only the free-form chat
   replies themselves are inherently non-deterministic and shouldn't be
   asserted on exact text in the default suite.
