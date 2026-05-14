#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { createDefaultAdapters } from './adapters/index.js';
import { PriceComparisonService } from './services/priceComparisonService.js';
import { SearchService } from './services/searchService.js';
import { executeToolCall, listTools } from './tools/handlers.js';
import { logger } from './util/log.js';

export async function createServer(): Promise<Server> {
  const adapters = createDefaultAdapters();
  const searchService = new SearchService(adapters);
  const priceComparisonService = new PriceComparisonService(adapters);

  const server = new Server(
    { name: 'swiss-shopping-mcp', version: '0.1.0' },
    { capabilities: { tools: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => listTools());

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    throw new Error(`Unknown prompt: ${req.params.name}`);
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    executeToolCall(req.params, { searchService, priceComparisonService }),
  );

  return server;
}

async function main(): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('swiss-shopping-mcp running on stdio');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);
    try {
      await server.close();
    } catch (e) {
      logger.error('Error during shutdown:', e);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    logger.error('Fatal error:', e);
    process.exit(1);
  });
}
