import {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { getAllCapabilityStatuses } from '../adapters/sourceRegistry.js';
import { Chain, DietaryPreference, ResultMetadata, SourceCapability } from '../adapters/types.js';
import { PriceComparisonService } from '../services/priceComparisonService.js';
import { SearchService } from '../services/searchService.js';

const CHAINS = [
  'migros',
  'coop',
  'aldi',
  'denner',
  'lidl',
  'farmy',
  'volg',
  'ottos',
] as const satisfies readonly Chain[];
const DIETARY_PREFERENCES = [
  'vegan',
  'vegetarian',
  'gluten-free',
] as const satisfies readonly DietaryPreference[];

export const TOOL_TIMEOUT_MS: Record<string, number> = {
  search_products: 8_000,
  search_promotions: 8_000,
  find_stores: 8_000,
  compare_prices: 10_000,
  get_source_status: 1_000,
  get_store_availability_support: 1_000,
  lookup_store_product_availability: 8_000,
};

const chainEnum = z.enum(CHAINS);
const dietaryPreferenceEnum = z.enum(DIETARY_PREFERENCES);
const matchModeEnum = z.enum(['balanced', 'literal']);
const comparisonBasisEnum = z.enum(['packPrice', 'unitPrice']);

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
    matchMode: matchModeEnum.optional(),
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
    comparisonBasis: comparisonBasisEnum.optional(),
    includePromotions: z.boolean().optional(),
    matchMode: matchModeEnum.optional(),
  })
  .strict();

const searchPromotionsInputSchema = z
  .object({
    query: z.string().trim().min(1),
    chains: z.array(chainEnum).min(1).optional(),
    maxPrice: z.number().positive().optional(),
    category: z.string().trim().min(1).optional(),
    limit: z.number().int().positive().max(100).optional(),
    matchMode: matchModeEnum.optional(),
  })
  .strict();

const availabilitySupportInputSchema = z
  .object({
    chains: z.array(chainEnum).min(1).optional(),
  })
  .strict();

const lookupStoreAvailabilityInputSchema = z
  .object({
    chain: chainEnum,
    storeId: z.string().trim().min(1),
    query: z.string().trim().min(1),
    matchMode: matchModeEnum.optional(),
  })
  .strict();

const SOURCE_CAPABILITIES = [
  'productSearch',
  'promotions',
  'storeSearch',
  'availability',
  'nutrition',
] as const satisfies readonly SourceCapability[];

const sourceStatusInputSchema = z
  .object({
    chains: z.array(chainEnum).min(1).optional(),
    capabilities: z.array(z.enum(SOURCE_CAPABILITIES)).min(1).optional(),
  })
  .strict();

const TOOL_NAMES = [
  'search_products',
  'search_promotions',
  'find_stores',
  'compare_prices',
  'get_store_availability_support',
  'lookup_store_product_availability',
  'get_source_status',
] as const;

type ToolName = (typeof TOOL_NAMES)[number];

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

function withMetadata(
  payload: Record<string, unknown>,
  metadata?: ResultMetadata
): Record<string, unknown> {
  if (!metadata) {
    return payload;
  }

  return {
    ...payload,
    ...(metadata.sourceWarnings ? { sourceWarnings: metadata.sourceWarnings } : {}),
    ...(metadata.sources ? { sources: metadata.sources } : {}),
    ...(metadata.summary ? { summary: metadata.summary } : {}),
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

type ToolInputSchema = {
  type: 'object';
  properties?: Record<string, object>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

function getInputSchemaForTool(name: ToolName): ToolInputSchema {
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
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum returned products',
        },
        matchMode: {
          type: 'string',
          enum: ['balanced', 'literal'],
          description:
            "Matching strategy: 'balanced' (default) allows generic-to-specific aliases like pasta -> penne; 'literal' enforces exact token matching.",
        },
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
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum returned stores',
        },
      },
      required: ['location'],
      additionalProperties: false,
    };
  }

  if (name === 'search_promotions') {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Promotion search query' },
        chains: {
          type: 'array',
          items: { type: 'string', enum: CHAINS },
          description: 'Restrict promotion search to specific chains',
        },
        maxPrice: { type: 'number', description: 'Maximum promotion price in CHF' },
        category: { type: 'string', description: 'Promotion category filter' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum returned promotions',
        },
        matchMode: {
          type: 'string',
          enum: ['balanced', 'literal'],
          description:
            "Matching strategy: 'balanced' (default) allows generic-to-specific aliases; 'literal' enforces exact token matching.",
        },
      },
      required: ['query'],
      additionalProperties: false,
    };
  }

  if (name === 'get_store_availability_support') {
    return {
      type: 'object',
      properties: {
        chains: {
          type: 'array',
          items: { type: 'string', enum: CHAINS },
          description: 'Restrict support lookup to specific chains',
        },
      },
      additionalProperties: false,
    };
  }

  if (name === 'lookup_store_product_availability') {
    return {
      type: 'object',
      properties: {
        chain: { type: 'string', enum: CHAINS, description: 'Chain where the store belongs' },
        storeId: { type: 'string', description: 'Store identifier from find_stores' },
        query: { type: 'string', description: 'Product query to check for in the selected store' },
        matchMode: {
          type: 'string',
          enum: ['balanced', 'literal'],
          description:
            "Matching strategy: 'balanced' (default) allows generic-to-specific aliases; 'literal' enforces exact token matching.",
        },
      },
      required: ['chain', 'storeId', 'query'],
      additionalProperties: false,
    };
  }

  if (name === 'get_source_status') {
    return {
      type: 'object',
      properties: {
        chains: {
          type: 'array',
          items: { type: 'string', enum: CHAINS },
          description: 'Restrict status to specific chains (defaults to all)',
        },
        capabilities: {
          type: 'array',
          items: { type: 'string', enum: SOURCE_CAPABILITIES },
          description: 'Restrict status to specific capabilities (defaults to all)',
        },
      },
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
      limitPerChain: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description:
          'Number of candidates evaluated and returned per chain (default 1). Increasing this reveals alternative products.',
      },
      comparisonBasis: {
        type: 'string',
        enum: ['packPrice', 'unitPrice'],
        description:
          "Whether to rank by 'packPrice' (total price for the product, default) or 'unitPrice' (price per kg/l/piece).",
      },
      includePromotions: {
        type: 'boolean',
        description: 'When true, include matching promotions as effective-price offers.',
      },
      matchMode: {
        type: 'string',
        enum: ['balanced', 'literal'],
        description:
          "Matching strategy: 'balanced' (default) allows generic-to-specific aliases; 'literal' enforces exact token matching.",
      },
    },
    required: ['query'],
    additionalProperties: false,
  };
}

export function listTools(): ListToolsResult {
  return {
    tools: TOOL_NAMES.map((name) => ({
      name,
      description:
        name === 'search_products'
          ? 'Search for products across Swiss grocery chains'
          : name === 'search_promotions'
            ? 'Search current promotions across Swiss grocery chains'
            : name === 'find_stores'
              ? 'Find grocery stores by city, ZIP code, or location keywords'
              : name === 'get_store_availability_support'
                ? 'List store-level product availability support by chain'
                : name === 'lookup_store_product_availability'
                  ? 'Check whether products matching a query are available in a specific store'
                  : name === 'get_source_status'
                    ? 'Get the source capability status matrix for all supported Swiss chains'
                    : 'Compare cross-chain prices for matching products',
      inputSchema: getInputSchemaForTool(name),
    })),
  };
}

function isSupportedToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

export async function executeToolCall(
  params: CallToolRequest['params'],
  dependencies: ToolDependencies
): Promise<CallToolResult> {
  if (!isSupportedToolName(params.name)) {
    return toolError('UNKNOWN_TOOL', `Unknown tool: ${params.name}`);
  }

  if (params.name === 'search_products') {
    const parsedInput = searchProductsInputSchema.safeParse(params.arguments ?? {});
    if (!parsedInput.success) {
      return toolError('INVALID_ARGUMENTS', getValidationErrorMessage(parsedInput.error));
    }

    const result = await dependencies.searchService.searchProducts(parsedInput.data);
    if (!result.ok) {
      return toolError(result.error.code, result.error.message ?? 'Product search failed.');
    }
    return toolSuccess(withMetadata({ products: result.data }, result.metadata));
  }

  if (params.name === 'find_stores') {
    const parsedInput = findStoresInputSchema.safeParse(params.arguments ?? {});
    if (!parsedInput.success) {
      return toolError('INVALID_ARGUMENTS', getValidationErrorMessage(parsedInput.error));
    }

    const result = await dependencies.searchService.findStores(parsedInput.data);
    if (!result.ok) {
      return toolError(result.error.code, result.error.message ?? 'Store search failed.');
    }
    return toolSuccess(withMetadata({ stores: result.data }, result.metadata));
  }

  if (params.name === 'search_promotions') {
    const parsedInput = searchPromotionsInputSchema.safeParse(params.arguments ?? {});
    if (!parsedInput.success) {
      return toolError('INVALID_ARGUMENTS', getValidationErrorMessage(parsedInput.error));
    }

    const result = await dependencies.searchService.searchPromotions(parsedInput.data);
    if (!result.ok) {
      return toolError(result.error.code, result.error.message ?? 'Promotion search failed.');
    }
    return toolSuccess(withMetadata({ promotions: result.data }, result.metadata));
  }

  if (params.name === 'get_store_availability_support') {
    const parsedInput = availabilitySupportInputSchema.safeParse(params.arguments ?? {});
    if (!parsedInput.success) {
      return toolError('INVALID_ARGUMENTS', getValidationErrorMessage(parsedInput.error));
    }

    const support = dependencies.searchService.getStoreAvailabilitySupport(parsedInput.data.chains);
    return toolSuccess({ support });
  }

  if (params.name === 'lookup_store_product_availability') {
    const parsedInput = lookupStoreAvailabilityInputSchema.safeParse(params.arguments ?? {});
    if (!parsedInput.success) {
      return toolError('INVALID_ARGUMENTS', getValidationErrorMessage(parsedInput.error));
    }

    const result = await dependencies.searchService.lookupStoreProductAvailability(
      parsedInput.data.chain,
      {
        storeId: parsedInput.data.storeId,
        query: parsedInput.data.query,
        matchMode: parsedInput.data.matchMode,
      }
    );
    if (!result.ok) {
      return toolError(
        result.error.code,
        result.error.message ?? 'Store product availability lookup failed.'
      );
    }
    return toolSuccess({ availability: result.data });
  }

  if (params.name === 'get_source_status') {
    const parsedInput = sourceStatusInputSchema.safeParse(params.arguments ?? {});
    if (!parsedInput.success) {
      return toolError('INVALID_ARGUMENTS', getValidationErrorMessage(parsedInput.error));
    }

    const statuses = getAllCapabilityStatuses(
      parsedInput.data.chains,
      parsedInput.data.capabilities as SourceCapability[] | undefined
    );
    return toolSuccess({ statuses });
  }

  const parsedInput = comparePricesInputSchema.safeParse(params.arguments ?? {});
  if (!parsedInput.success) {
    return toolError('INVALID_ARGUMENTS', getValidationErrorMessage(parsedInput.error));
  }

  const result = await dependencies.priceComparisonService.comparePrices(parsedInput.data);
  if (!result.ok) {
    return toolError(result.error.code, result.error.message ?? 'Price comparison failed.');
  }
  return toolSuccess(withMetadata({ comparison: result.data }, result.metadata));
}
