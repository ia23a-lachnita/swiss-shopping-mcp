// PWA chat agent loop. See docs/active/CHAT_AGENT_ARCHITECTURE_PLAN.md for
// the full research/decision trail behind the framework, model, and
// grounding-discipline choices made here.
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { convertToModelMessages, LanguageModel, stepCountIs, streamText, UIMessage } from 'ai';

import { ToolDependencies } from '../tools/handlers.js';
import { createAgentTools } from './tools.js';
import { repairToolCall } from './toolCallRepair.js';

// Re-verify this lineup against `GET https://openrouter.ai/api/v1/models`
// before relying on it long-term — OpenRouter's free-tier catalog rotates.
// Snapshot verified live 2026-07-29.
export const PRIMARY_MODEL_ID = 'google/gemma-4-31b-it:free';
export const FALLBACK_MODEL_IDS = [
  PRIMARY_MODEL_ID,
  'nvidia/nemotron-3-super-120b-a12b:free',
  'openai/gpt-oss-20b:free',
] as const;

const MAX_STEPS = 12;
const REQUEST_TIMEOUT_MS = 15_000;

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

The user may write in German, French, Italian, or English (all common in
Switzerland) — reply in the language they used.`;

export interface ChatAgentRequest {
  messages: UIMessage[];
  dependencies: ToolDependencies;
  /** Test-only override — production callers always get the real OpenRouter model. */
  model?: LanguageModel;
}

function resolveModel(): LanguageModel {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not set. The chat agent requires an OpenRouter API key at runtime.'
    );
  }

  const openrouter = createOpenRouter({ apiKey });
  // Primary model id drives the request's top-level `model`; `models` is
  // OpenRouter's own server-side fallback chain (walked in order on
  // downtime/rate-limit/context-length/moderation failures), so a single
  // request already carries primary + fallback + emergency fallback.
  return openrouter(PRIMARY_MODEL_ID, { models: [...FALLBACK_MODEL_IDS] });
}

export async function runChatAgent({
  messages,
  dependencies,
  model,
}: ChatAgentRequest): Promise<ReturnType<typeof streamText>> {
  return streamText({
    model: model ?? resolveModel(),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    tools: createAgentTools(dependencies),
    stopWhen: stepCountIs(MAX_STEPS),
    abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    experimental_repairToolCall: repairToolCall,
  });
}
