// Salvage for *text-form* tool calls — the failure mode reported from a real
// phone on 2026-08-04 (docs/active/PWA_UX_FIX_PLAN_2026-08-04.md §5): instead
// of using the provider's tool-calling API, the model wrote a Hermes/Qwen-style
// template into its message content:
//
//   <tool_call>
//   <function=lookup_store_product_availability_storeId>
//   5537? Actually we need to pass: { chain: "coop", storeId: "5532", query: "almond milk"}
//
// Nothing was ever parsed as a tool call, so `experimental_repairToolCall`
// (which only fires once the SDK *has* a call to repair) never ran, no tool
// executed, and the raw tags streamed to the user as the assistant's answer.
//
// This module is the deterministic recovery layer for that text: it finds the
// tag, recovers the real tool name from the mangled one, and pulls the
// arguments out of the object literal the model wrote — which, as the sample
// above shows, is frequently not valid JSON either. It parses only; turning the
// result back into a tool call is `textToolCallMiddleware.ts`'s job, and the
// existing `toolCallRepair.ts` still gets the final say on the arguments.
import { TOOL_NAMES, type ToolName } from '../tools/handlers.js';

/** Tag openers observed from models that skip the tool-calling API. */
const TRIGGERS = ['<tool_call', '<function_call', '<function='] as const;

export interface SalvagedToolCall {
  toolName: ToolName;
  /** Stringified JSON, matching the provider contract for a tool call's `input`. */
  input: string;
}

/** Index of the earliest tool-call tag in `text`, or -1 when there is none. */
export function findTriggerIndex(text: string): number {
  let earliest = -1;
  for (const trigger of TRIGGERS) {
    const index = text.indexOf(trigger);
    if (index !== -1 && (earliest === -1 || index < earliest)) {
      earliest = index;
    }
  }
  return earliest;
}

/**
 * How many trailing characters of `text` could still grow into a tag opener.
 * A streaming filter must withhold exactly this much: `<tool` arriving in one
 * chunk and `_call>` in the next is a tool call, not prose.
 */
export function partialTriggerTailLength(text: string): number {
  let longest = 0;
  for (const trigger of TRIGGERS) {
    const maxLength = Math.min(trigger.length - 1, text.length);
    for (let length = maxLength; length > longest; length -= 1) {
      if (text.endsWith(trigger.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

export function looksLikeToolCallSyntax(text: string): boolean {
  return findTriggerIndex(text) !== -1;
}

/** `<function=NAME>`, `<function=NAME{…}`, or a `"name": "NAME"` field. */
const FUNCTION_TAG_NAME = /<function(?:_call)?=\s*([^\s>{,"]+)/;
const NAME_FIELD = /"?\bname"?\s*[:=]\s*"([^"]+)"/;

/**
 * Map whatever the model wrote back onto a real tool. Longest-prefix first:
 * the observed `lookup_store_product_availability_storeId` is
 * `lookup_store_product_availability` with a parameter name glued on, and a
 * plain prefix match would otherwise be ambiguous between tools that share a
 * stem (`lookup_store_product_availability` vs `lookup_availability_by_location`).
 */
export function resolveToolName(raw: string): ToolName | undefined {
  const lastSegment = raw.trim().split(/[./:]/).pop() ?? '';
  const normalized = lastSegment.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!normalized) return undefined;

  const candidates = [...TOOL_NAMES].sort((a, b) => b.length - a.length);
  return (
    candidates.find((name) => name === normalized) ??
    candidates.find((name) => normalized.startsWith(name)) ??
    candidates.find((name) => normalized.includes(name))
  );
}

/**
 * Source text of the first balanced `{…}` at or after `fromIndex`, string-aware
 * so a brace inside a quoted value does not end the object early.
 */
export function extractFirstObject(text: string, fromIndex = 0): string | undefined {
  const start = text.indexOf('{', fromIndex);
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return undefined; // never closed — the model was cut off mid-object
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The observed sample wrote `{ chain: "coop", storeId: "5532" }` — bare keys,
 * so `JSON.parse` rejects it outright. Each repair is tried only after the
 * stricter parse has already failed, so well-formed JSON is never rewritten.
 */
function parseLooseObject(source: string): Record<string, unknown> | undefined {
  const quoteBareKeys = (s: string): string => s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  const dropTrailingCommas = (s: string): string => s.replace(/,\s*([}\]])/g, '$1');
  const singleToDoubleQuotes = (s: string): string => s.replace(/'([^'\\]*)'/g, '"$1"');

  const attempts = [
    source,
    dropTrailingCommas(quoteBareKeys(source)),
    dropTrailingCommas(quoteBareKeys(singleToDoubleQuotes(source))),
  ];

  for (const attempt of attempts) {
    try {
      const parsed: unknown = JSON.parse(attempt);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // try the next repair
    }
  }
  return undefined;
}

/** `{"name": "x", "arguments": {…}}` wrappers carry the real arguments one level down. */
function unwrapArguments(parsed: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['arguments', 'parameters', 'args', 'input']) {
    const nested = parsed[key];
    if (isPlainObject(nested)) return nested;
    if (typeof nested === 'string') {
      const reparsed = parseLooseObject(nested);
      if (reparsed) return reparsed;
    }
  }
  return parsed;
}

/**
 * Recover a real tool call from assistant text, or `undefined` when the text
 * is not recoverable — the caller must then surface the text as a failed turn
 * rather than pass it off as an answer. Arguments are returned as written
 * (minus the syntax repairs above); `toolCallRepair.ts` still validates and
 * fixes aliases before the tool runs.
 */
export function salvageToolCallFromText(text: string): SalvagedToolCall | undefined {
  if (!looksLikeToolCallSyntax(text)) return undefined;

  const rawName = FUNCTION_TAG_NAME.exec(text)?.[1] ?? NAME_FIELD.exec(text)?.[1];
  if (!rawName) return undefined;

  const toolName = resolveToolName(rawName);
  if (!toolName) return undefined;

  const objectSource = extractFirstObject(text);
  if (!objectSource) return undefined;

  const parsed = parseLooseObject(objectSource);
  if (!parsed) return undefined;

  return { toolName, input: JSON.stringify(unwrapArguments(parsed)) };
}
