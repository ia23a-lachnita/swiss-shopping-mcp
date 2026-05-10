#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { logger } from './util/log.js';

export async function createServer(): Promise<Server> {
  const server = new Server(
    { name: 'swiss-shopping-mcp', version: '0.1.0' },
    { capabilities: { tools: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search_products',
        description: 'Search for products across Swiss grocery chains',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Product search query' },
          },
          required: ['query'],
        },
      },
      {
        name: 'find_stores',
        description: 'Find grocery stores by location',
        inputSchema: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'ZIP code or city name' },
          },
          required: ['location'],
        },
      },
    ],
  }));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    throw new Error(`Unknown prompt: ${req.params.name}`);
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    throw new Error(`Unknown tool: ${req.params.name}`);
  });

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

main().catch((e) => {
  logger.error('Fatal error:', e);
  process.exit(1);
});
