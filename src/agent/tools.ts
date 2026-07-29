// Adapts the existing MCP tool layer (src/tools/handlers.ts) into Vercel AI
// SDK `tool()` definitions. Reuses the same zod input schemas and the same
// `executeToolCall` dispatcher that the MCP stdio transport uses — this file
// adds no new search/compare/availability logic of its own.
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import { NormalizedProduct } from '../adapters/types.js';
import {
  availabilitySupportInputSchema,
  comparePricesInputSchema,
  executeToolCall,
  findStoresInputSchema,
  listTools,
  lookupStoreAvailabilityInputSchema,
  searchProductsInputSchema,
  searchPromotionsInputSchema,
  sourceStatusInputSchema,
  ToolDependencies,
  TOOL_NAMES,
  ToolName,
} from '../tools/handlers.js';

/** Total tool calls allowed in one chat turn's multi-step loop, across all steps. */
const TOOL_CALL_BUDGET = 24;

const TOOL_DESCRIPTIONS: Record<ToolName, string> = Object.fromEntries(
  listTools().tools.map((t) => [t.name, t.description])
) as Record<ToolName, string>;

/**
 * Strips the largest, least decision-relevant fields (nutrition, ingredients)
 * from a product before it re-enters the model's context. The full product
 * still reaches the PWA client via the tool-result stream part — only the
 * copy fed back into the next model turn is trimmed.
 */
function stripProductForModel(product: NormalizedProduct): Omit<NormalizedProduct, 'nutrition' | 'ingredients'> {
  const rest: Partial<NormalizedProduct> = { ...product };
  delete rest.nutrition;
  delete rest.ingredients;
  return rest as Omit<NormalizedProduct, 'nutrition' | 'ingredients'>;
}

async function runTool(
  name: ToolName,
  args: unknown,
  dependencies: ToolDependencies,
  budget: { remaining: number }
): Promise<Record<string, unknown>> {
  if (budget.remaining <= 0) {
    return {
      error: {
        code: 'TOOL_BUDGET_EXCEEDED',
        message: `This turn already made ${TOOL_CALL_BUDGET} tool calls — summarize what you have and ask the user to narrow the request instead of calling more tools.`,
      },
    };
  }
  budget.remaining -= 1;

  try {
    const result = await executeToolCall({ name, arguments: args as Record<string, unknown> }, dependencies);
    if (result.isError) {
      return { error: (result.structuredContent as { error?: unknown })?.error ?? { message: 'Tool call failed.' } };
    }
    return (result.structuredContent as Record<string, unknown>) ?? {};
  } catch (err) {
    // executeToolCall already resolves domain failures to isError results; a
    // thrown exception here means something unexpected broke, and it must
    // resolve to a tool result the model can see and report, not a crashed stream.
    return {
      error: {
        code: 'TOOL_EXECUTION_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export function createAgentTools(dependencies: ToolDependencies): ToolSet {
  const budget = { remaining: TOOL_CALL_BUDGET };

  const tools = {
    search_products: tool({
      description: TOOL_DESCRIPTIONS.search_products,
      inputSchema: searchProductsInputSchema,
      execute: async (input) => {
        const raw = await runTool('search_products', input, dependencies, budget);
        if (Array.isArray(raw.products)) {
          raw.products = (raw.products as NormalizedProduct[]).map(stripProductForModel);
        }
        return raw;
      },
    }),
    search_promotions: tool({
      description: TOOL_DESCRIPTIONS.search_promotions,
      inputSchema: searchPromotionsInputSchema,
      execute: async (input) => {
        const raw = await runTool('search_promotions', input, dependencies, budget);
        if (Array.isArray(raw.promotions)) {
          raw.promotions = (raw.promotions as NormalizedProduct[]).map(stripProductForModel);
        }
        return raw;
      },
    }),
    find_stores: tool({
      description: TOOL_DESCRIPTIONS.find_stores,
      inputSchema: findStoresInputSchema,
      execute: (input) => runTool('find_stores', input, dependencies, budget),
    }),
    compare_prices: tool({
      description: TOOL_DESCRIPTIONS.compare_prices,
      inputSchema: comparePricesInputSchema,
      execute: async (input) => {
        const raw = await runTool('compare_prices', input, dependencies, budget);
        const comparison = raw.comparison as { offers?: Array<{ product: NormalizedProduct }> } | undefined;
        if (comparison?.offers) {
          comparison.offers = comparison.offers.map((offer) => ({
            ...offer,
            product: stripProductForModel(offer.product) as NormalizedProduct,
          }));
        }
        return raw;
      },
    }),
    get_store_availability_support: tool({
      description: TOOL_DESCRIPTIONS.get_store_availability_support,
      inputSchema: availabilitySupportInputSchema,
      execute: (input) => runTool('get_store_availability_support', input, dependencies, budget),
    }),
    lookup_store_product_availability: tool({
      description: TOOL_DESCRIPTIONS.lookup_store_product_availability,
      inputSchema: lookupStoreAvailabilityInputSchema,
      execute: (input) => runTool('lookup_store_product_availability', input, dependencies, budget),
    }),
    get_source_status: tool({
      description: TOOL_DESCRIPTIONS.get_source_status,
      inputSchema: sourceStatusInputSchema,
      execute: (input) => runTool('get_source_status', input, dependencies, budget),
    }),
    get_metrics: tool({
      description: TOOL_DESCRIPTIONS.get_metrics,
      inputSchema: z.object({}).strict(),
      execute: () => runTool('get_metrics', {}, dependencies, budget),
    }),
  };

  // Defensive check against TOOL_NAMES drifting out of sync with this map.
  for (const name of TOOL_NAMES) {
    if (!(name in tools)) {
      throw new Error(`createAgentTools is missing a definition for tool "${name}".`);
    }
  }

  return tools as ToolSet;
}
