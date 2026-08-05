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

// Re-verify this lineup against `GET https://openrouter.ai/api/v1/models`
// before relying on it long-term — OpenRouter's free-tier catalog rotates.
// Catalog snapshot verified live 2026-08-04; all three ids still list `tools`
// support (only 13 free models do).
//
// Order set by measurement, not reputation — `npm run test:eval` pinned to one
// model at a time via SWISS_SHOPPING_CHAT_MODEL, 2026-08-05:
//
//   openai/gpt-oss-20b:free                 5/10
//   nvidia/nemotron-3-super-120b-a12b:free  3/10  (incl. a 7-step tool loop)
//   google/gemma-4-31b-it:free              0/10  — its provider pool refused
//                                                  every request, twice, 30
//                                                  minutes apart
//
// Gemma was primary until then. Nothing looked broken from outside because
// OpenRouter's `models` chain quietly routed around the dead pool — every turn
// simply paid a failed attempt first.
//
// The chain is now two entries, not three, and that is also a measurement: the
// shipped config (chain enabled) scored 3/10 while pinned gpt-oss scored 5/10,
// because a chain routes to *whichever member answers*, so every weak member
// drags the shipped result toward itself. Resilience still argues for having
// one fallback; it does not argue for keeping a model whose pool is currently
// refusing us. Restore gemma when its pool recovers and a pinned run earns it
// back — the text-form tool-call salvage was built for that model and still
// covers it.
export const PRIMARY_MODEL_ID = 'openai/gpt-oss-20b:free';
export const FALLBACK_MODEL_IDS = [PRIMARY_MODEL_ID, 'nvidia/nemotron-3-super-120b-a12b:free'] as const;

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
    abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    experimental_repairToolCall: repairToolCall,
    // One, not the default two. A 429 is already handled below us by a
    // rate-limit-aware wait; retrying it up here just fires more requests at
    // the counter that is currently refusing us — which is exactly how the
    // 2026-08-04 eval turned a brush with the cap into 8 red cases. This
    // retry is left in place only for transient non-429 failures.
    maxRetries: 1,
  });
}
