#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { fileURLToPath } from 'url';

import { createDefaultAdapters, CreateDefaultAdaptersOptions } from './adapters/index.js';
import { ChainAdapter } from './adapters/types.js';
import { CatalogService, openCatalogDb, runMigrations } from './catalog/index.js';
import { PriceComparisonService } from './services/priceComparisonService.js';
import { SearchService } from './services/searchService.js';
import { createDefaultWebProductSearch } from './services/webProductSearchService.js';
import { executeToolCall, listTools } from './tools/handlers.js';
import { logger } from './util/log.js';
import { MetricsCollector } from './util/metrics.js';

export interface CreateServerOptions {
  adapterOptions?: CreateDefaultAdaptersOptions;
  /** Override the default adapter set (tests inject stub adapters here). */
  adapters?: ChainAdapter[];
}

export async function createServer(options: CreateServerOptions = {}): Promise<Server> {
  const adapters = options.adapters ?? createDefaultAdapters(options.adapterOptions);
  // Initialize catalog (SQLite) — best-effort, never blocks startup
  let catalog: CatalogService | undefined;
  try {
    const db = openCatalogDb(undefined, process.env);
    runMigrations(db);
    catalog = new CatalogService(db);
  } catch (err) {
    logger.warn('Catalog DB init failed — running without local index:', err);
  }

  const webProductSearch = createDefaultWebProductSearch(adapters, {
    cacheDirectory: options.adapterOptions?.cacheDirectory,
    catalog,
  });
  const metrics = new MetricsCollector(options.adapterOptions?.cacheDirectory);
  const searchService = new SearchService(adapters, { webProductSearch, catalog, metrics });
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

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    logger.error('Fatal error:', e);
    process.exit(1);
  });
}
