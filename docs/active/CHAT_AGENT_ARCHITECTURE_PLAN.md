# PWA Chat Agent — Architecture Plan

Date: 2026-07-28
Status: planned, decisions finalized after five review passes (widened research + antigravity-mcp gemini-3.6-flash) — model choice was corrected twice after owner pushback found incomplete comparisons; not yet implemented

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

## Core framework: Vercel AI SDK (decided against real alternatives, not just the first plausible answer)

Adopt the **Vercel AI SDK** (`ai` npm package, v6) with the official
**`@openrouter/ai-sdk-provider`** (OpenRouterTeam-maintained, 385+ dependents
on npm as of 2026-07-28) — this is the current standard TypeScript toolkit
for tool-calling + streaming chat, not a hand-rolled loop/SSE protocol.

**Compared against the real alternatives, not picked as the only option
considered:**

| Option | What it actually is | Why not chosen |
| --- | --- | --- |
| Vercel AI SDK (`ai`) | "A streaming UI library, not an agent framework — no durable workflows, no first-class memory, no orchestration beyond a single tool loop" (per current comparative write-ups) | **Chosen** — see below |
| Mastra | TypeScript-native agent framework: durable workflows that survive process restarts, persistent cross-session memory, multi-agent fan-out, branching workflows with retries, built-in evals/tracing | Every flagship feature is state/persistence/orchestration this app deliberately doesn't want — session state was already decided as client-side/stateless (see "Session / history state" below), and this is a single bounded tool loop per request, not a multi-agent workflow. Would add a heavier framework and server-side state machinery for capabilities that go unused. |
| LangChain.js | Graph-based orchestration framework | Confirmed heavier/more complex than needed; explicitly recommended against for "a thin chat UI with no agent flow or retrieval" — that's exactly this app's shape |
| Hand-rolled (raw OpenRouter/OpenAI-compatible fetch + custom SSE) | No framework at all | Reinvents a tool-calling loop, streaming protocol, and Zod-schema-to-tool-definition glue that a maintained library already does correctly — not justified when the maintained option fits this exact shape |

**Confirmed, not assumed:** the SDK runs standalone in plain Node/Express —
it does not require Next.js or Vercel's hosting platform, despite the
branding. Relevant because this app self-hosts on a Raspberry Pi via Docker
(`src/web/server.ts`), not on Vercel's platform — this was a real
unverified assumption worth checking, and it checked out.

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

## Model choice (decided against the full real candidate pool, not a menu)

**Primary: `google/gemma-4-31b-it:free`. Fallback (via OpenRouter's model
array): `nvidia/nemotron-3-super-120b-a12b:free`. Emergency fallback:
`openai/gpt-oss-20b:free`.**

**Correction history (two rounds, both owner-caught, both real):**
1. First pass compared only 2 of ~17 free models (primary gpt-oss-20b,
   fallback Nemotron 3 Ultra) — Gemma 4 31B had been a candidate since the
   very first review (recommended then for multilingual reasons) but was
   silently dropped before the final benchmark comparison and never actually
   researched at decision time.
2. Second pass corrected to Gemma 4 primary / gpt-oss-20b fallback, but
   still hadn't checked the *entire* free catalog. Widened research to all
   17 free models on OpenRouter (confirmed live) plus an independent
   research pass from antigravity-mcp — which suggested six models (Qwen
   2.5 72B, Llama 3.3 70B, Mistral Small 24B, Qwen 2.5 Coder 32B, Hermes 3
   405B, DeepSeek V3) that turned out, on live verification against
   OpenRouter's actual API, to **all be paid now**, not free — that
   "independent research" wasn't actually grounded in live data either, so
   it was discarded. Real remaining candidates were researched properly one
   by one (see table below), which surfaced `nvidia/nemotron-3-super-120b-a12b:free`
   as a stronger, same-benchmark-lineage fallback than gpt-oss-20b.

**Full real candidate comparison** (all confirmed live as free +
tool-calling-capable on `openrouter.ai/api/v1/models` on 2026-07-28):

| Model | Size | Real published benchmark | Verdict |
| --- | --- | --- | --- |
| `google/gemma-4-31b-it:free` | 31B dense | 76.9% Tau2, 86.4% agentic tool-use, 85.2% MMLU Pro; documented French/Italian gains | **Primary** — best directly-comparable tool-calling number, right latency class, genuine Swiss-multilingual fit |
| `nvidia/nemotron-3-super-120b-a12b:free` | 120B MoE / 12B active | TauBench V2: Airline 56.25%, Retail 62.83%, Telecom 64.36%, avg 61.15% (NVIDIA's own eval via Nemo Evaluator SDK) | **Fallback** — same Tau2/TauBench-V2 lineage as the primary, so a genuinely comparable number, not a different benchmark being compared loosely; MoE keeps active compute low despite 120B total |
| `openai/gpt-oss-20b:free` | 20B dense | Tau-Bench v1 (older/different version): Retail 54.8%, Airline 38.0% | **Emergency fallback only** — lower ceiling on an older benchmark version, kept as the lightest/fastest last resort |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 550B / 55B active | 91% PinchBench, 65-70.4% SWEBench Verified (no Tau-bench number found) | Excluded — strong numbers on different benchmarks, but 550B total risks real queueing/cold-start on free shared inference, unacceptable even as a fallback for interactive chat |
| `poolside/laguna-s-2.1:free` / `laguna-xs-2.1:free` | 118B/8B active, 33B/3B active | SWE-bench Multilingual 63.1%, Terminal-Bench 2.0 37.5% | Excluded — coding-agent specialized (IDE/terminal tool use); no general/conversational tool-calling benchmark exists for this domain |
| `cohere/north-mini-code:free` | 30B MoE / 3B active | SWE-Bench Verified 80.2% pass@10, Terminal-Bench v2 55.1% pass@10 | Excluded — same domain-mismatch as Poolside; strong at coding-agent tasks, unverified at conversational shopping tool-use |
| `inclusionai/ling-3.0-flash:free` | 124B MoE / 5.1B active | None published — days old, vendor claims only | Excluded — no independent verification at all |
| Smaller Nemotron nano/VL variants (9B/12B/30B) | — | No benchmarks found | Excluded — no evidence, and unlikely to beat Nemotron Super's own modest 61% given the size gap |

**Honest limits of this evidence** (flagged directly, not glossed over):
Tau-Bench v1 / TauBench V2 / Tau2 share the same lineage (multi-step
tool-use-in-environment evaluation) but differ in task difficulty and
scoring specifics across versions — comparing gpt-oss-20b's v1 score to
Nemotron Super's V2 score is a reasonable extrapolation, not a strictly
controlled 1:1 comparison. None of these benchmarks test Swiss-German/
French/Italian code-switching specifically (they're English-language
environments) — Gemma 4's multilingual edge is a real, separately-documented
property, not something Tau2 itself measured. And OpenRouter's real-time
free-tier GPU allocation for a 120B MoE model (Nemotron Super) vs. a 31B
dense model (Gemma 4) is genuinely unknown until observed in practice —
benchmark scores don't predict free-tier queueing behavior.

See the candidate comparison table above for the full research trail. Two
operational notes not captured in the table:

- Re-verify all model IDs still exist and are still free at implementation
  time (`openrouter.ai/api/v1/models`) — this free lineup rotates, and
  BFCL's actual leaderboard leader (Qwen) was confirmed to have zero free
  models on OpenRouter at all (cheapest paid Qwen is $0.03/M tokens),
  meaning "check the top of a leaderboard" alone doesn't work as a shortcut
  for this decision — the free/paid boundary has to be checked directly.
- **Operational quirks to watch for with Gemma 4 specifically:** its native
  turn-formatting differs from OpenAI-style chat templates — OpenRouter
  translates the standard `tools: [...]` payload into Gemma's expected
  format automatically, but test schema edge cases (nested objects,
  optional/null fields) to confirm the translation doesn't silently drop a
  parameter constraint; keep the system prompt explicit about when to call
  tools, since Gemma can be overly cautious/pedantic under ambiguous
  instructions.

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

## Testing (decided — three layers, not two)

Real current practice for LLM agent testing is described as three distinct
layers (unit / fixture-eval / integration), and the first pass at this plan
only had two — it skipped the middle layer entirely. Corrected:

1. **Unit layer — `ai/test`'s `MockLanguageModelV3`** (current AI SDK v6
   helper): deterministic, zero cost, no real API key, no network call.
   Validates schema parsing, tool dispatch, system-prompt formatting, the
   timeout/error-object guards above, and the list-detection pre-pass — the
   same way this repo already unit-tests everything else.
2. **Golden-eval layer (the gap that was missing) — a small hand-rolled
   Vitest fixture set, not a third-party eval platform.** 10-15 static
   `{prompt, expectedTool, expectedParams | null}` cases covering normal
   queries, out-of-scope queries (should trigger no tool at all), and
   ambiguous ones, run against the **real** chosen model (or a cheap
   stand-in), asserting on tool name + Zod-validated arguments — not full
   response text. This is what actually catches "I tweaked the system
   prompt and the model quietly stopped calling `search_products`," which
   the mock layer structurally cannot catch (the mock always returns what
   the test told it to return) and a single smoke test doesn't cover
   (it only proves the happy path still works, not prompt regressions
   across query variety). Dedicated eval platforms (LangSmith, Braintrust,
   DeepEval) formalize this same pattern but are proportionate for teams
   with real eval infrastructure investment — for a single-developer
   project already averse to unneeded abstractions, a plain fixture file
   plus a `describe.each`/`it.each` Vitest loop is the right size, run
   manually or pre-release rather than on every CI run (keeps it out of the
   free-tier request budget on every push).
3. **Integration/live layer — one opt-in live smoke test**, matching this
   repo's existing `.live.test.ts` convention (gated the same way, e.g.
   `LIVE_SOURCE_TESTS=1`), running one real end-to-end tool-calling turn
   against the actual OpenRouter API and the real primary model to confirm
   credentials, schema translation, and real network latency — this repo
   already treats "real network integration needs one real opt-in check" as
   non-negotiable for every other live-vendor path.

## Decisions log (resolved, no longer open)

- PWA surface: a new chat tab, not folded into an existing one.
- Core framework: Vercel AI SDK + `@openrouter/ai-sdk-provider`, chosen over
  Mastra (adds durable-workflow/persistent-memory machinery this app's
  already-stateless architecture doesn't use) and LangChain.js (heavier,
  meant for graph-based multi-agent orchestration this single-tool-loop
  chat doesn't need) — not a hand-rolled loop/SSE protocol either, since the
  SDK already does that correctly and confirmed to run standalone in plain
  Node/Express (no Next.js/Vercel-hosting requirement, relevant for this
  app's Raspberry Pi/Docker self-hosting).
- Model: primary `google/gemma-4-31b-it:free` (strongest directly-comparable
  tool-calling benchmark across the full real candidate pool — 17 free
  OpenRouter models checked, not just the first few found — plus genuine
  multilingual relevance for German/French/Italian Swiss queries), fallback
  `nvidia/nemotron-3-super-120b-a12b:free` (same Tau2/TauBench-V2 benchmark
  lineage as the primary, a real comparable number), emergency fallback
  `openai/gpt-oss-20b:free`. `nvidia/nemotron-3-ultra-550b-a55b:free`
  excluded entirely (too large/slow even as a fallback).
- Testing: three layers, not two — `MockLanguageModelV3` unit tests, a
  small hand-rolled Vitest golden-eval fixture set (10-15 cases asserting
  correct tool selection, run against the real model, catches system-prompt
  regressions neither the mock nor a single smoke test would catch), and
  one opt-in live smoke test.
- Still genuinely open only where reality is unknowable until real code
  exists: whether the list-detection pre-pass ships in v1 or as a fast
  follow depends on how badly the *actual chosen model* dribbles tool calls
  in practice — that's an empirical result to observe during
  implementation, not a design preference to guess at now.
