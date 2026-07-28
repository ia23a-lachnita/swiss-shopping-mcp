# PWA Chat Agent — Architecture Plan

Date: 2026-07-28
Status: planned, decisions finalized (research + antigravity-mcp gemini-3.6-flash, three passes), not yet implemented

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

**Every decision below was reached by checking real, current sources (live
API calls, published benchmarks, current library docs) — not assumed or
picked from training-data memory, since this is 2026 tooling.**

## Why this is cheaper to build than it sounds

Read the actual source before designing this, not just assuming: `src/tools/handlers.ts`
already has exactly the seam this needs —

- `listTools()` returns `{name, description, inputSchema}` for all 8 existing
  MCP tools (`search_products`, `search_promotions`, `find_stores`,
  `compare_prices`, `get_store_availability_support`,
  `lookup_store_product_availability`, `get_source_status`, `get_metrics`).
  `inputSchema` is already hand-written plain JSON Schema.
- `executeToolCall(params: {name, arguments}, dependencies)` is a single
  exported async function that dispatches any of those 8 tools and returns a
  `CallToolResult`, already fully decoupled from the MCP stdio/SSE transport
  — callable in-process from any new HTTP route.

So the agent's tool layer is a thin wrapper over code that already exists,
not a new implementation of search/compare/availability logic.

## Core framework: Vercel AI SDK (decided, not optional)

Adopt the **Vercel AI SDK** (`ai` npm package, v6) with the official
**`@openrouter/ai-sdk-provider`** (OpenRouterTeam-maintained, 385+ dependents
on npm as of 2026-07-28) — this is the current standard TypeScript toolkit
for tool-calling + streaming chat, not a hand-rolled loop/SSE protocol.

New dependencies: `ai`, `@ai-sdk/react` (frontend `useChat` hook),
`@openrouter/ai-sdk-provider`.

**What the SDK gives for free:**

- `streamText({ model, tools, messages, maxSteps })` — the tool-calling loop
  itself (dispatch tool_calls, feed results back, continue until a plain-text
  answer or `maxSteps` is hit) is a library primitive, not something to
  hand-roll.
- `tool({ parameters: zodSchema, execute })` accepts a **Zod schema
  directly** — this repo's existing zod input schemas in
  `src/tools/handlers.ts` (`searchProductsInputSchema`, etc.) wire in with
  minimal adaptation instead of hand-converting to raw JSON Schema.
- Parallel tool execution when a model response contains multiple
  `tool_calls` in one step is handled by the SDK automatically.
- `@openrouter/ai-sdk-provider` explicitly advertises "fine-grained tool
  streaming" — tool-call arguments stream without buffering, which directly
  answers the earlier open question of whether streaming and tool-calling
  fight each other here (they don't; this provider is built for it).
- Frontend: `useChat` (`@ai-sdk/react`) handles streamed message state,
  in-progress tool-call rendering, and message history — replaces most of a
  hand-rolled SSE client.

**What the SDK does NOT give you — still implement these explicitly:**

1. **A global wall-clock timeout across the whole multi-step loop.**
   `maxSteps` bounds the number of steps, not elapsed time. Pass
   `abortSignal: AbortSignal.timeout(15_000)` into `streamText(...)`
   explicitly.
2. **Graceful tool failure, not a crashed stream.** If a tool's `execute()`
   throws, the SDK loop stops hard by default. Wrap `executeToolCall` calls
   so failures resolve to an explicit `{ error: "..." }` payload returned
   *as a tool result*, not a thrown exception — the model then sees the
   failure as context (and should say so per the grounding rules below)
   instead of the request dying.
3. **Tool-result truncation before it re-enters the model's context** — map
   raw `search_products`/`compare_prices` payloads down to the fields the
   model actually needs (`{title, price, chain, availability}`) before
   returning them from `execute()`. Multi-step conversations with full raw
   vendor payloads at each step will blow up context size and latency
   otherwise.
4. **Total tool-call budget as a safety net.** `maxSteps: 12` bounds rounds,
   but track a running tool-call counter too, in case a single step ever
   requests an unusually large batch.

## Model choice (decided, not a menu)

**Primary: `openai/gpt-oss-20b:free`. Fallback (via OpenRouter's model
array): `nvidia/nemotron-3-ultra-550b-a55b:free`.**

Research trail, not a guess:

- Checked the live Berkeley Function-Calling Leaderboard (BFCL-V4): Qwen
  models dominate (Qwen3.7 Max 0.750 down to Qwen3.5-9B 0.661). Checked live
  against OpenRouter's own API: **zero Qwen models are free there**
  (cheapest paid Qwen is $0.03/M tokens) — BFCL's actual leaderboard leader
  is unreachable under the $0 constraint. None of the free tool-calling
  models available (Nemotron 3 family, Gemma 4, gpt-oss) appear on BFCL at
  all, so the decision uses vendor-published *agentic* benchmarks instead —
  arguably more relevant anyway, since BFCL tests atomic function-call
  correctness, not multi-turn conversational tool orchestration, which is
  what this feature actually does.
- `openai/gpt-oss-20b:free`: OpenAI's own published Tau-Bench numbers (a
  real multi-turn tool-use benchmark) — 54.8% retail, 38.0% airline. 20B
  parameters.
- `nvidia/nemotron-3-ultra-550b-a55b:free`: NVIDIA's own published numbers —
  91% PinchBench (agent productivity), 65-70.4% SWEBench Verified, 1M
  context, hybrid Mamba-Transformer MoE (55B active / 550B total), explicitly
  marketed as an orchestration model.
- **Why gpt-oss-20b is primary despite the smaller/lower-ceiling numbers:**
  latency is the actual UX-critical variable for an interactive chat, and a
  550B-parameter MoE model on OpenRouter's free shared inference tier means
  real queueing/cold-start/TTFT risk — a 4-8s wait for a first token breaks
  conversational UX. The shopping/search tool-orchestration task this agent
  actually does (map "find Bio milk under 3 CHF" to the right tool call) is
  well within a 20B model's demonstrated Tau-Bench-retail capability; it
  doesn't need SWE-bench-grade reasoning. Nemotron 3 Ultra is the fallback
  for when the primary hits a rate limit or fails tool extraction, not the
  default path.
- Re-verify both model IDs still exist and are still free at implementation
  time (`openrouter.ai/api/v1/models`) — this free lineup rotates.

## The N+1 problem, re-examined for chat

OpenAI-style tool calling lets one model turn emit *multiple* `tool_calls`
at once, which looked like it might dissolve the earlier "1 LLM call per
list item" rate-limit problem. It doesn't, reliably, on free models
specifically — smaller/quantized free models tend to dribble out 2-3 tool
calls per round rather than batching a full list's worth at once, burning
rounds (and daily quota) faster than expected.

**Mitigations, not a single fix:**

1. System-prompt directive mandating "issue ALL necessary tool calls in one
   turn" — necessary but not sufficient alone.
2. **Backend pre-pass for explicit lists**: when the user's message looks
   like a list (heuristic: newlines/bullets/`"2x"`-style tokens), don't rely
   on the chat model to realize it needs N `search_products` calls — run the
   deterministic list-splitting from `SHOPPING_LIST_AGENT_PLAN.md` first,
   fan out retrieval directly, and inject results into context before the
   model's first real turn. Keeps the shopping-list case bounded regardless
   of how well the chosen chat model batches tool calls generically.

## Session / history state

**Client-side, not server-side.** No auth/accounts in this app (unchanged
`CLAUDE.md` scope); a server-side session store would add TTL/cleanup debt
for no real benefit. Store full conversation history in the PWA
(IndexedDB), resend the visible user/assistant messages on each
`POST /api/chat`; the backend stays a stateless worker holding state only
for the duration of one request's tool-calling steps. Don't persist
intermediate tool-call messages into the client's saved history — only the
final human-readable exchange.

## Streaming

Use the AI SDK's native streaming (`streamText` + `useChat`) rather than
hand-rolling an SSE protocol — superseded the earlier draft of this doc,
which proposed a custom `event: status/delta/done` protocol modeled on this
repo's existing `/api/search-products/stream`. That precedent is still
useful conceptually (this app already has SSE experience) but the AI SDK's
own transport (which `useChat` consumes directly) replaces the need to
design one by hand here.

## Grounding discipline in open-ended chat

The shopping-list feature's `RESOLVED/AMBIGUOUS/UNRESOLVED/DEGRADED` status
contract was designed for one structured task; general chat needs the same
discipline applied more broadly — a system-prompt instruction alone ("don't
invent prices") is not reliable enough against free/open-weight models,
which will readily hallucinate a plausible CHF price when a tool call
returns nothing.

Two layers, both required:

1. **Strict system-prompt rules** — only state prices/availability/stores
   that came from a tool call *in this session*; if a tool call fails or
   returns empty, say so explicitly; never extrapolate from general
   knowledge of Swiss grocery prices.
2. **UI-level "verified" grounding, not just trusting the model's prose** —
   the chat endpoint returns both the assistant's text *and* the structured
   tool payloads actually returned during that turn; the PWA renders those
   as distinct product/price cards under the message (reusing the existing
   `ProductSheet`/card components), so a hallucinated claim in the model's
   free text is visually distinguishable from a tool-backed fact.

## Testing (decided)

- **Default suite: `ai/test`'s `MockLanguageModelV3`** (current AI SDK v6
  helper) — deterministic, zero cost, no real API key, no network call.
  Validates schema parsing, tool dispatch, system-prompt formatting, the
  timeout/error-object guards above, and the list-detection pre-pass, the
  same way this repo already unit-tests everything else.
- **One opt-in live smoke test, matching this repo's existing
  `.live.test.ts` convention** (gated the same way, e.g.
  `LIVE_SOURCE_TESTS=1`) that runs one real end-to-end tool-calling turn
  against the actual OpenRouter API and the real primary model. Reasoning:
  free-tier open models drift, drop system-prompt rules, or emit invalid
  tool-call JSON over time in ways a mock can't catch — this repo already
  treats "real network integration needs one real opt-in check" as
  non-negotiable for every other live-vendor path, and this is no
  different.

## Decisions log (resolved, no longer open)

- PWA surface: a new chat tab, not folded into an existing one.
- Core framework: Vercel AI SDK + `@openrouter/ai-sdk-provider`, not a
  hand-rolled loop/SSE protocol.
- Model: primary `openai/gpt-oss-20b:free`, fallback
  `nvidia/nemotron-3-ultra-550b-a55b:free`.
- Testing: `MockLanguageModelV3` default suite + one opt-in live smoke test.
- Still genuinely open only where reality is unknowable until real code
  exists: whether the list-detection pre-pass ships in v1 or as a fast
  follow depends on how badly the *actual chosen model* dribbles tool calls
  in practice — that's an empirical result to observe during
  implementation, not a design preference to guess at now.
