// PWA chat agent loop. See docs/active/CHAT_AGENT_ARCHITECTURE_PLAN.md for
// the full research/decision trail behind the framework, model, and
// grounding-discipline choices made here.
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import {
  convertToModelMessages,
  LanguageModel,
  stepCountIs,
  streamText,
  UIMessage,
  wrapLanguageModel,
} from 'ai';

import { ToolDependencies } from '../tools/handlers.js';
import { createRateLimitedFetch } from './openRouterRateLimit.js';
import { textToolCallSalvageMiddleware } from './textToolCallMiddleware.js';
import { createAgentTools } from './tools.js';
import { repairToolCall } from './toolCallRepair.js';

// Order set by measurement, not reputation. `npm run test:eval` pinned to one
// model at a time via SWISS_SHOPPING_CHAT_MODEL, whole catalog swept
// 2026-08-05 (only 13 free models declare `tools` at all; each row is the
// golden set's 10 cases plus the median turn latency the eval now prints):
//
//   poolside/laguna-s-2.1:free              10/10   10.8s   <- primary
//   inclusionai/ling-3.0-flash:free          9/10    9.6s
//   nvidia/nemotron-3-ultra-550b-a55b:free   9/10   16.3s
//   cohere/north-mini-code:free              9/10   19.7s
//   poolside/laguna-xs-2.1:free              5/10    5.1s  (fastest, but 3
//                                                          cases errored out)
//   openai/gpt-oss-20b:free                  5/10          (previous primary)
//   nvidia/nemotron-3-super-120b-a12b:free   3/10
//   google/gemma-4-31b-it:free               0/10          (pool refuses us)
//
// The three kept here are the only ones that both score ≥9/10 and answer in a
// reasonable time — which matters because a chain routes to *whichever member
// answers*, so every weak member drags the shipped result toward itself (three
// weak members measured 3/10 shipped against 5/10 pinned). With every member
// at 9–10/10 that hazard is gone, so a three-model chain is now worth its
// resilience: laguna and gpt-oss have both been seen returning
// `upstream_provider_shared_pool` 429s, and pool availability is the failure
// this chain actually protects against.
//
// Two models to keep away from, both found by the same sweep:
// `nvidia/nemotron-nano-12b-v2-vl:free` hung for 90s on a one-line probe (the
// `chunkMs` stall detector below exists for exactly that), and
// `google/gemma-4-31b-it:free` — the primary until this morning — has a
// provider pool that refuses every request. Nothing looked broken from outside
// while it was primary, because the `models` chain quietly routed around it;
// every turn simply paid a failed attempt first.
//
// Re-verify against `GET https://openrouter.ai/api/v1/models` before relying
// on this long-term — the free catalog rotates, and today's sweep found six
// tool-capable models that did not exist when this lineup was first written.
export const PRIMARY_MODEL_ID = 'poolside/laguna-s-2.1:free';
export const FALLBACK_MODEL_IDS = [
  PRIMARY_MODEL_ID,
  'inclusionai/ling-3.0-flash:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
] as const;

/**
 * Pins the agent to one model id, with no fallback chain. Exists so the
 * golden-eval can attribute a result to a specific model: with the normal
 * `models` chain, OpenRouter may serve any of the three and the run measures
 * "whichever answered", which is useless for deciding which to promote.
 *
 * Eval/diagnostic use only — production leaves it unset and keeps the chain.
 */
const MODEL_OVERRIDE_ENV = 'SWISS_SHOPPING_CHAT_MODEL';

const MAX_STEPS = 12;
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Free-tier models are not just occasionally wrong, they are occasionally
 * *slow in specific ways*, and a single overall timeout cannot tell those
 * apart from a model that is simply thinking:
 *
 * - `stepMs` bounds one model call, so a step that stalls cannot eat the whole
 *   turn's budget and leave the remaining steps with nothing.
 * - `chunkMs` is the stall detector that matters most here: a stream that has
 *   opened but stopped producing tokens looks identical to a working one until
 *   the total budget expires. This ends it as soon as the gap is longer than a
 *   real model ever pauses.
 *
 * Reported symptom this addresses: "high latency, loooong responses" on free
 * models, and nemotron in particular being slow to first token.
 */
const STEP_TIMEOUT_MS = 20_000;
const STREAM_STALL_TIMEOUT_MS = 15_000;
/**
 * Bounds the "loooong responses" half of the same complaint. Generous enough
 * for a reasoning model's thinking plus a product list, which is why it is not
 * tighter — these models spend real tokens before the answer starts.
 */
const MAX_OUTPUT_TOKENS = 2_000;
/**
 * How long a turn may wait *in line* for a rate-limit slot, which is a
 * different budget from how long the model may take to answer. A shopper
 * watching a chat bubble will not wait a minute for a queue slot; a batch eval
 * happily will, and passes its own. Conflating the two made every queued eval
 * case fail instantly instead of waiting.
 */
const DEFAULT_QUEUE_WAIT_MS = 12_000;

const SYSTEM_PROMPT = `You are the Swiss Shopping assistant, embedded in a PWA that compares
groceries across Swiss retail chains (Migros, Coop, Aldi, Denner, Lidl, Volg, Otto's).

Grounding rules (never break these):
- Only state a price, availability, or store fact that came back from one of
  your tool calls in this conversation. Never state a Swiss grocery price,
  stock status, or store detail from general knowledge — you do not have
  current data without calling a tool.
- If a tool call fails, times out, or returns no results, say so plainly
  ("I couldn't find X" / "that chain's data is unavailable right now") —
  never paper over a failure with an invented plausible-sounding answer.
- When you list products, prefer the tool's returned name/brand/price/chain
  fields verbatim over paraphrasing numbers.

Tool-call efficiency:
- When the user's message is a list (multiple items, one per line, or
  comma/bullet separated — e.g. a shopping list), issue ALL the necessary
  tool calls for every item in the SAME turn rather than one at a time
  across multiple turns.
- Prefer compare_prices when the user wants the cheapest option across
  chains, search_products for a general look-up, and
  lookup_store_product_availability / find_stores when the question is about
  a specific physical store.
- Tool parameter names are exact — read each tool's schema. In particular,
  the field for restricting a search to specific chains is always named
  "chains" and is always an array (e.g. ["migros", "coop"]), never "chain",
  "source", "sources", or a single string.

Location:
- Some tools (lookup_availability_by_location, find_stores) need a location.
  Never ask for one proactively at the start of the chat — only when such a
  tool is about to run and no location is known yet for this conversation.
- When the user gives a location (whether you asked or they volunteered it
  unprompted), call set_chat_location with it before using it in another
  tool. If they later state a different location in the same conversation,
  call set_chat_location again — the newest one always wins.

The user may write in German, French, Italian, or English (all common in
Switzerland) — reply in the language they used.`;

export interface ChatAgentRequest {
  messages: UIMessage[];
  dependencies: ToolDependencies;
  /** Chat-scoped location the client has previously resolved via `set_chat_location`, if any. */
  activeLocation?: string;
  /** Test-only override — production callers always get the real OpenRouter model. */
  model?: LanguageModel;
  /**
   * How long this caller may wait for a free-tier rate-limit slot. Batch
   * callers (the golden-eval) pass a large value; the interactive chat keeps
   * the short default so a shopper gets an answer or an honest error, not a
   * silent minute in a queue.
   */
  maxQueueWaitMs?: number;
}

function resolveModel(queueDeadline: number): LanguageModel {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not set. The chat agent requires an OpenRouter API key at runtime.'
    );
  }

  // Paced and 429-aware — see openRouterRateLimit.ts. The free tier's cap is
  // 20 requests/minute across the whole account, which is also why the
  // `models` chain below cannot rescue a rate limit: every id in it is
  // `:free` and shares that one counter.
  const openrouter = createOpenRouter({ apiKey, fetch: createRateLimitedFetch({ queueDeadline }) });

  const pinned = process.env[MODEL_OVERRIDE_ENV]?.trim();
  if (pinned) {
    return openrouter(pinned); // no `models` chain — one model, attributable result
  }
  // Primary model id drives the request's top-level `model`; `models` is
  // OpenRouter's own server-side fallback chain (walked in order on
  // downtime/rate-limit/context-length/moderation failures), so a single
  // request already carries primary + fallback + emergency fallback.
  return openrouter(PRIMARY_MODEL_ID, { models: [...FALLBACK_MODEL_IDS] });
}

/**
 * Every model this agent talks to gets the text-form tool-call salvage.
 * Anything that is not a v3 model instance — a bare model id string, or a
 * legacy v2 model — passes through untouched, since a v3 middleware cannot
 * wrap it. Applied to the test override too, so the recovery path is
 * exercised by the same harness as the normal one.
 */
function withToolCallSalvage(model: LanguageModel): LanguageModel {
  if (typeof model === 'string' || model.specificationVersion !== 'v3') {
    return model;
  }
  return wrapLanguageModel({ model, middleware: textToolCallSalvageMiddleware });
}

export async function runChatAgent({
  messages,
  dependencies,
  activeLocation,
  model,
  maxQueueWaitMs = DEFAULT_QUEUE_WAIT_MS,
}: ChatAgentRequest): Promise<ReturnType<typeof streamText>> {
  const system = activeLocation
    ? `${SYSTEM_PROMPT}\n\nThe user's current chat location is "${activeLocation}". Use it for location-based tools unless they just gave a different one in this message.`
    : SYSTEM_PROMPT;

  // Queue budget, not the request budget: how long this turn may wait for a
  // rate-limit slot before we tell the caller so, rather than stalling.
  const queueDeadline = Date.now() + maxQueueWaitMs;

  return streamText({
    model: withToolCallSalvage(model ?? resolveModel(queueDeadline)),
    system,
    messages: await convertToModelMessages(messages),
    tools: createAgentTools(dependencies),
    stopWhen: stepCountIs(MAX_STEPS),
    timeout: {
      totalMs: REQUEST_TIMEOUT_MS,
      stepMs: STEP_TIMEOUT_MS,
      chunkMs: STREAM_STALL_TIMEOUT_MS,
    },
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    experimental_repairToolCall: repairToolCall,
    // One, not the default two. A 429 is already handled below us by a
    // rate-limit-aware wait; retrying it up here just fires more requests at
    // the counter that is currently refusing us — which is exactly how the
    // 2026-08-04 eval turned a brush with the cap into 8 red cases. This
    // retry is left in place only for transient non-429 failures.
    maxRetries: 1,
  });
}
