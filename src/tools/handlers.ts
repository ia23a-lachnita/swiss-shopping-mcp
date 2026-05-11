import { CallToolRequest, CallToolResult, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { Chain, DietaryPreference } from '../adapters/types.js';
import { PriceComparisonService } from '../services/priceComparisonService.js';
import { SearchService } from '../services/searchService.js';

const CHAINS: Chain[] = ['migros', 'coop', 'aldi', 'denner', 'lidl', 'farmy', 'volg', 'ottos'];
const DIETARY_PREFERENCES: DietaryPreference[] = ['vegan', 'vegetarian', 'gluten-free'];

const chainEnum = z.enum(CHAINS);
const dietaryPreferenceEnum = z.enum(DIETARY_PREFERENCES);

const searchProductsInputSchema = z
  .object({
    query: z.string().trim().min(1),
    chains: z.array(chainEnum).min(1).optional(),
    maxPrice: z.number().positive().optional(),
    category: z.string().trim().min(1).optional(),
    tags: z.array(z.string().trim().min(1)).min(1).optional(),
    excludeAllergens: z.array(z.string().trim().min(1)).min(1).optional(),
    dietaryPreferences: z.array(dietaryPreferenceEnum).min(1).optional(),
    limit: z.number().int().positive().max(100).optional(),
  })
  .strict();

const findStoresInputSchema = z
  .object({
    location: z.string().trim().min(1),
    chains: z.array(chainEnum).min(1).optional(),
    limit: z.number().int().positive().max(100).optional(),
  })
  .strict();

const comparePricesInputSchema = z
  .object({
    query: z.string().trim().min(1),
    chains: z.array(chainEnum).min(1).optional(),
    maxPrice: z.number().positive().optional(),
    quantity: z.number().positive().optional(),
    limitPerChain: z.number().int().positive().max(50).optional(),
  })
  .strict();

const toolSchemas = {
  search_products: searchProductsInputSchema,
  find_stores: findStoresInputSchema,
  compare_prices: comparePricesInputSchema,
} as const;

type ToolName = keyof typeof toolSchemas;

export interface ToolDependencies {
  searchService: SearchService;
  priceComparisonService: PriceComparisonService;
}

function toolError(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } },
  };
}

function toolSuccess(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function getValidationErrorMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'input';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function getInputSchemaForTool(name: ToolName): Record<string, unknown> {
  if (name === 'search_products') {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Product search query' },
        chains: {
          type: 'array',
          items: { type: 'string', enum: CHAINS },
          description: 'Restrict search to specific chains',
        },
        maxPrice: { type: 'number', description: 'Maximum product price in CHF' },
        category: { type: 'string', description: 'Product category filter' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Required product tags' },
        excludeAllergens: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exclude products with these allergens',
        },
        dietaryPreferences: {
          type: 'array',
          items: { type: 'string', enum: DIETARY_PREFERENCES },
          description: 'Dietary preferences to match',
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum returned products' },
      },
      required: ['query'],
      additionalProperties: false,
    };
  }

  if (name === 'find_stores') {
    return {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City, ZIP code, or location term' },
        chains: {
          type: 'array',
          items: { type: 'string', enum: CHAINS },
          description: 'Restrict store lookup to specific chains',
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum returned stores' },
      },
      required: ['location'],
      additionalProperties: false,
    };
  }

  return {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Product query to compare between chains' },
      chains: {
        type: 'array',
        items: { type: 'string', enum: CHAINS },
        description: 'Restrict comparison to specific chains',
      },
      maxPrice: { type: 'number', description: 'Maximum product price in CHF' },
      quantity: { type: 'number', minimum: 0.01, description: 'Requested quantity multiplier' },
      limitPerChain: { type: 'integer', minimum: 1, maximum: 50, description: 'Candidates evaluated per chain' },
    },
    required: ['query'],
    additionalProperties: false,
  };
}

export function listTools(): ListToolsResult {
  return {
    tools: (Object.keys(toolSchemas) as ToolName[]).map((name) => ({
      name,
      description:
        name === 'search_products'
          ? 'Search for products across Swiss grocery chains'
          : name === 'find_stores'
            ? 'Find grocery stores by city, ZIP code, or location keywords'
            : 'Compare cross-chain prices for matching products',
      inputSchema: getInputSchemaForTool(name),
    })),
  };
}

function isSupportedToolName(name: string): name is ToolName {
  return name in toolSchemas;
}

export async function executeToolCall(
  params: CallToolRequest['params'],
  dependencies: ToolDependencies,
): Promise<CallToolResult> {
  if (!isSupportedToolName(params.name)) {
    return toolError('UNKNOWN_TOOL', `Unknown tool: ${params.name}`);
  }

  const parser = toolSchemas[params.name];
  const parsedInput = parser.safeParse(params.arguments ?? {});
  if (!parsedInput.success) {
    return toolError('INVALID_ARGUMENTS', getValidationErrorMessage(parsedInput.error));
  }

  if (params.name === 'search_products') {
    const result = await dependencies.searchService.searchProducts(parsedInput.data);
    if (!result.ok) {
      return toolError(result.error.code, result.error.message ?? 'Product search failed.');
    }
    return toolSuccess({ products: result.data });
  }

  if (params.name === 'find_stores') {
    const result = await dependencies.searchService.findStores(parsedInput.data);
    if (!result.ok) {
      return toolError(result.error.code, result.error.message ?? 'Store search failed.');
    }
    return toolSuccess({ stores: result.data });
  }

  const result = await dependencies.priceComparisonService.comparePrices(parsedInput.data);
  if (!result.ok) {
    return toolError(result.error.code, result.error.message ?? 'Price comparison failed.');
  }
  return toolSuccess({ comparison: result.data });
}
