// Deterministic tool-call argument repair. Discovered empirically during
// mandatory browser verification (see CLAUDE.md): the free tool-calling
// models this app depends on sometimes guess plausible-but-wrong parameter
// names (`chain` or `sources` instead of the schema's `chains` array)
// against our `.strict()` zod schemas. The AI SDK's default behavior on a
// schema-validation failure is a bare "An error occurred." tool result with
// no hint of what was wrong — the model then has nothing to self-correct
// from and, per real observation, gives up and hallucinates a fabricated
// answer instead (a direct grounding-discipline violation). This repair
// pass fixes the common alias/shape mistakes with zero extra LLM calls
// before the SDK gives up, rather than relying on the model to notice and
// retry with a corrected call.
import { NoSuchToolError, type ToolCallRepairFunction, type ToolSet } from 'ai';
import { z } from 'zod';

import {
  availabilitySupportInputSchema,
  comparePricesInputSchema,
  findStoresInputSchema,
  lookupAvailabilityByLocationInputSchema,
  lookupStoreAvailabilityInputSchema,
  searchProductsInputSchema,
  searchPromotionsInputSchema,
  setChatLocationInputSchema,
  sourceStatusInputSchema,
  ToolName,
} from '../tools/handlers.js';

const TOOL_SCHEMAS: Record<ToolName, z.AnyZodObject> = {
  search_products: searchProductsInputSchema,
  search_promotions: searchPromotionsInputSchema,
  find_stores: findStoresInputSchema,
  compare_prices: comparePricesInputSchema,
  get_store_availability_support: availabilitySupportInputSchema,
  lookup_store_product_availability: lookupStoreAvailabilityInputSchema,
  lookup_availability_by_location: lookupAvailabilityByLocationInputSchema,
  set_chat_location: setChatLocationInputSchema,
  get_source_status: sourceStatusInputSchema,
  get_metrics: z.object({}).strict(),
};

/** Wrong-but-plausible names models have been observed sending instead of `chains`. */
const CHAIN_FIELD_ALIASES = new Set(['chain', 'source', 'sources', 'vendor', 'vendors']);

function coerceChainsValue(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  // Models sometimes send a stringified array ('["migros"]') instead of a real array.
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // not JSON — treat as a single chain name below
  }
  return [value];
}

function repairInput(schema: z.AnyZodObject, rawInput: Record<string, unknown>): Record<string, unknown> {
  const knownKeys = new Set(Object.keys(schema.shape));
  const repaired: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rawInput)) {
    if (knownKeys.has(key)) {
      repaired[key] = key === 'chains' ? coerceChainsValue(value) : value;
      continue;
    }
    if (CHAIN_FIELD_ALIASES.has(key) && knownKeys.has('chains')) {
      repaired.chains = coerceChainsValue(value);
      continue;
    }
    // Unknown key with no known alias — drop it rather than let `.strict()`
    // reject the whole call over one extra field the model invented.
  }

  return repaired;
}

export const repairToolCall: ToolCallRepairFunction<ToolSet> = async ({ toolCall, error }) => {
  if (NoSuchToolError.isInstance(error)) {
    return null; // can't repair a call to a tool name that doesn't exist
  }

  const schema = TOOL_SCHEMAS[toolCall.toolName as ToolName];
  if (!schema) {
    return null;
  }

  let rawInput: unknown;
  try {
    rawInput = JSON.parse(toolCall.input) as unknown;
  } catch {
    return null; // not even valid JSON — nothing deterministic to fix
  }
  if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) {
    return null;
  }

  const repaired = repairInput(schema, rawInput as Record<string, unknown>);
  const result = schema.safeParse(repaired);
  if (!result.success) {
    return null; // give up — the model sees the original error and must ground its reply in that
  }

  return { ...toolCall, input: JSON.stringify(result.data) };
};
