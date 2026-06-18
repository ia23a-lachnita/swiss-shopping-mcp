import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';


import { createDefaultAdapters } from '../adapters/index.js';
import { getAllCapabilityStatuses } from '../adapters/sourceRegistry.js';
import { PriceComparisonService } from '../services/priceComparisonService.js';
import { SearchService } from '../services/searchService.js';
import { Chain } from '../adapters/types.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = join(process.cwd(), 'src', 'web', 'public');

const adapters = createDefaultAdapters();
const searchService = new SearchService(adapters);
const priceComparisonService = new PriceComparisonService(adapters);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function parseBody<T>(raw: string): { ok: true; data: T } | { ok: false; error: string } {
  try {
    const data = JSON.parse(raw) as T;
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'Invalid JSON body.' };
  }
}

async function serveStaticFile(res: ServerResponse, filePath: string): Promise<void> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

async function handleSearchProducts(res: ServerResponse, raw: string): Promise<void> {
  const parsed = parseBody<{
    query: string;
    chains?: Chain[];
    maxPrice?: number;
    category?: string;
    limit?: number;
  }>(raw);

  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, error: { code: 'INVALID_BODY', message: parsed.error } });
    return;
  }

  const { query, chains, maxPrice, category, limit } = parsed.data;
  if (!query || typeof query !== 'string') {
    sendJson(res, 400, { ok: false, error: { code: 'INVALID_QUERY', message: 'Query is required.' } });
    return;
  }

  const result = await searchService.searchProducts({
    query,
    chains,
    maxPrice,
    category,
    limit,
  });

  if (result.ok) {
    sendJson(res, 200, { ok: true, data: result.data, metadata: result.metadata });
  } else {
    sendJson(res, 500, { ok: false, error: result.error });
  }
}

async function handleFindStores(res: ServerResponse, raw: string): Promise<void> {
  const parsed = parseBody<{
    location: string;
    chains?: Chain[];
    limit?: number;
  }>(raw);

  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, error: { code: 'INVALID_BODY', message: parsed.error } });
    return;
  }

  const { location, chains, limit } = parsed.data;
  if (!location || typeof location !== 'string') {
    sendJson(res, 400, { ok: false, error: { code: 'INVALID_LOCATION', message: 'Location is required.' } });
    return;
  }

  const result = await searchService.findStores({ location, chains, limit });

  if (result.ok) {
    sendJson(res, 200, { ok: true, data: result.data, metadata: result.metadata });
  } else {
    sendJson(res, 500, { ok: false, error: result.error });
  }
}

async function handleComparePrices(res: ServerResponse, raw: string): Promise<void> {
  const parsed = parseBody<{
    query: string;
    chains?: Chain[];
    quantity?: number;
  }>(raw);

  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, error: { code: 'INVALID_BODY', message: parsed.error } });
    return;
  }

  const { query, chains, quantity } = parsed.data;
  if (!query || typeof query !== 'string') {
    sendJson(res, 400, { ok: false, error: { code: 'INVALID_QUERY', message: 'Query is required.' } });
    return;
  }

  const result = await priceComparisonService.comparePrices({
    query,
    chains,
    quantity,
  });

  if (result.ok) {
    sendJson(res, 200, { ok: true, data: result.data, metadata: result.metadata });
  } else {
    sendJson(res, 500, { ok: false, error: result.error });
  }
}

function handleSourceStatus(res: ServerResponse): void {
  const statuses = getAllCapabilityStatuses();
  sendJson(res, 200, { ok: true, data: statuses });
}

async function handleLookupAvailability(res: ServerResponse, raw: string): Promise<void> {
  const parsed = parseBody<{
    chain: string;
    query: string;
    storeId: string;
  }>(raw);

  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, error: { code: 'INVALID_BODY', message: parsed.error } });
    return;
  }

  const { chain, query, storeId } = parsed.data;
  if (!chain || !query || !storeId) {
    sendJson(res, 400, { ok: false, error: { code: 'INVALID_PARAMS', message: 'chain, query, and storeId are required.' } });
    return;
  }

  const result = await searchService.lookupStoreProductAvailability(chain as Chain, { query, storeId });

  if (result.ok) {
    sendJson(res, 200, { ok: true, data: result.data, metadata: result.metadata });
  } else {
    sendJson(res, 500, { ok: false, error: result.error });
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // API routes first — before static file catch-all
  if (req.method === 'POST' && url.pathname === '/api/search-products') {
    const body = await readBody(req);
    await handleSearchProducts(res, body);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/find-stores') {
    const body = await readBody(req);
    await handleFindStores(res, body);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/compare-prices') {
    const body = await readBody(req);
    await handleComparePrices(res, body);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/source-status') {
    handleSourceStatus(res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/availability') {
    const body = await readBody(req);
    await handleLookupAvailability(res, body);
    return;
  }

  // Static files
  if (req.method === 'GET' && url.pathname === '/') {
    await serveStaticFile(res, join(PUBLIC_DIR, 'index.html'));
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/')) {
    const filePath = join(PUBLIC_DIR, url.pathname);
    await serveStaticFile(res, filePath);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

const server = createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error('Unhandled error:', err);
    if (!res.headersSent) {
      sendJson(res, 500, {
        ok: false,
        error: { code: 'INTERNAL', message: 'Internal server error.' },
      });
    }
  }
});

function start(): void {
  server.listen(PORT, () => {
    console.log(`Swiss Shopping Web UI running at http://localhost:${PORT}`);
  });
}

if (process.argv[1]) {
  start();
}

export { server, start };
