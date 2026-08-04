import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { tmpdir } from 'node:os';

import { pipeUIMessageStreamToResponse, UIMessage } from 'ai';

import { runChatAgent } from '../agent/chatAgent.js';
import { createDefaultAdapters } from '../adapters/index.js';
import { reverseGeocodeAsync, resolveLocationAsync, suggestLocationsAsync } from '../util/geo.js';
import { getAllCapabilityStatuses } from '../adapters/sourceRegistry.js';
import { CatalogService, openCatalogDb, runMigrations } from '../catalog/index.js';
import { PriceComparisonService } from '../services/priceComparisonService.js';
import { SearchService } from '../services/searchService.js';
import { ChainHealthBreaker } from '../services/chainHealthBreaker.js';
import { SearchResultCache } from '../services/searchResultCache.js';
import { createDefaultWebProductSearch } from '../services/webProductSearchService.js';
import { Chain, StoreAvailabilityByLocationFilters } from '../adapters/types.js';
import { logger } from '../util/log.js';
import { MetricsCollector } from '../util/metrics.js';
import { ADAPTER_SOFT_TIMEOUT_MS, chainTimeoutMs } from '../util/timeout.js';

const PORT = Number(process.env.PORT) || 3000;
/** Allowance for catalog hydration + merge/rank once the fan-out is done, for the SSE ETA. */
const MERGE_ALLOWANCE_MS = 1_500;
const PUBLIC_DIR = join(process.cwd(), 'src', 'web', 'public');
// Built PWA assets (vite build output; see pwa/vite.config.ts).
const PWA_DIR = join(process.cwd(), 'dist', 'pwa');

const adapters = createDefaultAdapters();

// Initialize catalog (SQLite) — best-effort, never blocks startup
let catalog: CatalogService | undefined;
try {
  const db = openCatalogDb(undefined, process.env);
  runMigrations(db);
  catalog = new CatalogService(db);
} catch (err) {
  logger.warn('Catalog DB init failed — running without local index:', err);
}

const METRICS_CACHE_DIR =
  process.env.SWISS_SHOPPING_CACHE_DIR ?? join(tmpdir(), 'swiss-shopping-mcp-cache');
const metrics = new MetricsCollector(METRICS_CACHE_DIR);
const webProductSearch = createDefaultWebProductSearch(adapters, { catalog, metrics });
// Breaker + whole-query cache are opted into here, not inside SearchService:
// the MCP server and tests want a deterministic every-chain-every-time service.
const chainBreaker = new ChainHealthBreaker();
const resultCache = new SearchResultCache();
const searchService = new SearchService(adapters, {
  webProductSearch,
  catalog,
  metrics,
  chainBreaker,
  resultCache,
});
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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
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

function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * SSE variant of /api/search-products: emits an `init` event (chain count +
 * per-chain ETA derived from real measured latency history), a `progress`
 * event as each chain's vendor search resolves, then a `done` event carrying
 * the same envelope shape as the POST endpoint's response.
 */
async function handleSearchProductsStream(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const query = url.searchParams.get('query')?.trim() ?? '';
  if (!query) {
    sendJson(res, 400, { ok: false, error: { code: 'INVALID_QUERY', message: 'Query is required.' } });
    return;
  }

  const chainsParam = url.searchParams.get('chains');
  const chains = chainsParam
    ? (chainsParam.split(',').filter(Boolean) as Chain[])
    : undefined;
  const maxPriceParam = url.searchParams.get('maxPrice');
  const maxPrice = maxPriceParam ? Number(maxPriceParam) : undefined;
  const category = url.searchParams.get('category') ?? undefined;
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Number(limitParam) : undefined;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // The client closes the EventSource when the shopper edits the query and
  // restarts mid-search. Stop writing into the dead socket at that point —
  // the fan-out itself still runs to completion, which needs a real
  // AbortController through ChainAdapter.searchProducts (tracker item 4).
  let clientGone = false;
  req.on('close', () => {
    clientGone = true;
  });
  const send = (event: string, data: unknown): void => {
    if (clientGone) return;
    writeSseEvent(res, event, data);
  };

  const relevantChains = chains ?? adapters.map((adapter) => adapter.chain);
  const latencyByChain = metrics.snapshot().latency.byChain;
  send('init', {
    totalChains: relevantChains.length,
    chains: relevantChains,
    // p75, not max. Using max meant one historic outlier (an 18s cold Migros
    // start) pinned the countdown at ~18s for every later search, which then
    // always finished early — the estimate was never wrong-but-close, it was
    // just the worst case forever. Capped at the per-adapter soft timeout
    // because no chain can exceed it: raceWithTimeout resolves at that point.
    // Chains with no samples yet are simply absent, and the client falls back.
    // Each estimate is additionally capped at that chain's own budget, and a
    // chain the breaker has open is reported as 0 — it will be skipped, so
    // including its historic latency would inflate the countdown for a chain
    // that is about to return instantly.
    etaMsByChain: Object.fromEntries(
      relevantChains.flatMap((chain) => {
        if (chainBreaker.isOpen(chain)) return [[chain, 0]];
        const p75 = latencyByChain[chain]?.p75;
        return typeof p75 === 'number' ? [[chain, Math.min(p75, chainTimeoutMs(chain))]] : [];
      })
    ),
    /** Ceiling for chains with no measured history, so the client never guesses. */
    fallbackEtaMs: ADAPTER_SOFT_TIMEOUT_MS,
    /**
     * What each chain is still *allowed* to take. The p75 above is the likely
     * case and is wrong 25% of the time by construction; this is the hard cap
     * `raceWithTimeout` enforces, so a countdown bounded below by it can never
     * promise less time than a chain may legitimately still spend.
     */
    budgetMsByChain: Object.fromEntries(
      relevantChains.map((chain) => [chain, chainBreaker.isOpen(chain) ? 0 : chainTimeoutMs(chain)])
    ),
    /**
     * Everything after the last vendor answers: the optional web-search
     * augmentation plus the merge/rank step. Previously invisible to the
     * estimate, which is one of the three reasons it under-promised.
     */
    postFanOutMs:
      (searchService.webAugmentationPossible ? SearchService.webSearchSoftTimeoutMs : 0) +
      MERGE_ALLOWANCE_MS,
  });

  const result = await searchService.searchProducts(
    { query, chains, maxPrice, category, limit },
    { onChainProgress: (event) => send('progress', event) }
  );

  if (result.ok) {
    send('done', { ok: true, data: result.data, metadata: result.metadata });
  } else {
    send('done', { ok: false, error: result.error });
  }
  res.end();
}

function handleQuerySuggest(res: ServerResponse, url: URL): void {
  const q = url.searchParams.get('q')?.trim() ?? '';
  const limit = Math.min(Number(url.searchParams.get('limit')) || 8, 15);

  if (q.length < 2 || !catalog) {
    sendJson(res, 200, { ok: true, data: { suggestions: [] } });
    return;
  }

  const suggestions = catalog.suggestProductNames(q, limit);
  sendJson(res, 200, { ok: true, data: { suggestions } });
}

async function handleLocationSuggest(res: ServerResponse, url: URL): Promise<void> {
  const q = url.searchParams.get('q')?.trim() ?? '';
  const limit = Math.min(Number(url.searchParams.get('limit')) || 6, 10);

  if (q.length < 2) {
    sendJson(res, 200, { ok: true, data: { suggestions: [] } });
    return;
  }

  const suggestions = await suggestLocationsAsync(q, limit);
  sendJson(res, 200, { ok: true, data: { suggestions } });
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

function handleMetrics(res: ServerResponse): void {
  const snapshot = metrics.snapshot();
  sendJson(res, 200, { ok: true, data: snapshot });
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

async function handleStoreAvailabilityByLocation(res: ServerResponse, raw: string): Promise<void> {
  const parsed = parseBody<StoreAvailabilityByLocationFilters>(raw);

  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, error: { code: 'INVALID_BODY', message: parsed.error } });
    return;
  }

  const { query, location } = parsed.data;
  if (!query || !location) {
    sendJson(res, 400, { ok: false, error: { code: 'INVALID_PARAMS', message: 'query and location are required.' } });
    return;
  }

  const result = await searchService.lookupAvailabilityByLocation(parsed.data);

  if (result.ok) {
    sendJson(res, 200, { ok: true, data: result.data });
  } else {
    sendJson(res, 500, { ok: false, error: result.error });
  }
}

async function handleProductAvailability(res: ServerResponse, raw: string): Promise<void> {
  const parsed = parseBody<StoreAvailabilityByLocationFilters>(raw);

  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, error: { code: 'INVALID_BODY', message: parsed.error } });
    return;
  }

  const { query, location } = parsed.data;
  if (!query || !location) {
    sendJson(res, 400, { ok: false, error: { code: 'INVALID_PARAMS', message: 'query and location are required.' } });
    return;
  }

  const result = await searchService.lookupAvailabilityByLocationProductsFirst(parsed.data);

  if (result.ok) {
    sendJson(res, 200, { ok: true, data: result.data });
  } else {
    sendJson(res, 500, { ok: false, error: result.error });
  }
}

/**
 * PWA chat agent endpoint. Stateless per request: the client (IndexedDB, see
 * CHAT_AGENT_ARCHITECTURE_PLAN.md "Session / history state") resends the
 * full visible message history on every call; this handler holds no
 * conversation state between requests.
 */
async function handleChat(res: ServerResponse, raw: string): Promise<void> {
  const parsed = parseBody<{ messages: UIMessage[]; activeLocation?: string }>(raw);
  if (!parsed.ok || !Array.isArray(parsed.data.messages)) {
    sendJson(res, 400, { ok: false, error: { code: 'INVALID_BODY', message: 'messages array is required.' } });
    return;
  }

  try {
    const result = await runChatAgent({
      messages: parsed.data.messages,
      activeLocation: parsed.data.activeLocation,
      dependencies: { searchService, priceComparisonService },
    });
    await pipeUIMessageStreamToResponse({ response: res, stream: result.toUIMessageStream() });
  } catch (err) {
    logger.error('Chat agent request failed:', err);
    if (!res.headersSent) {
      sendJson(res, 500, {
        ok: false,
        error: {
          code: 'CHAT_AGENT_FAILED',
          message: err instanceof Error ? err.message : 'Chat agent request failed.',
        },
      });
    }
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

  if (req.method === 'GET' && url.pathname === '/api/search-products/stream') {
    await handleSearchProductsStream(req, res, url);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/query-suggest') {
    handleQuerySuggest(res, url);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/location-suggest') {
    await handleLocationSuggest(res, url);
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

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const body = await readBody(req);
    await handleChat(res, body);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/source-status') {
    handleSourceStatus(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/metrics') {
    handleMetrics(res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/availability') {
    const body = await readBody(req);
    await handleLookupAvailability(res, body);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/store-availability') {
    const body = await readBody(req);
    await handleStoreAvailabilityByLocation(res, body);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/product-availability') {
    const body = await readBody(req);
    await handleProductAvailability(res, body);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/reverse-geocode') {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      sendJson(res, 400, {
        ok: false,
        error: { code: 'INVALID_PARAMS', message: 'lat and lon query parameters are required numbers.' },
      });
      return;
    }
    const resolved = await reverseGeocodeAsync({ latitude: lat, longitude: lon });
    if (!resolved) {
      sendJson(res, 404, {
        ok: false,
        error: { code: 'NO_MATCH', message: 'No known Swiss locality near these coordinates.' },
      });
      return;
    }
    sendJson(res, 200, { ok: true, data: resolved });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/geocode-check') {
    const q = url.searchParams.get('q')?.trim() ?? '';
    if (q.length < 2) {
      sendJson(res, 200, { ok: true, data: { valid: false } });
      return;
    }
    const resolved = await resolveLocationAsync(q);
    sendJson(res, 200, { ok: true, data: { valid: resolved !== undefined } });
    return;
  }

  // Built PWA (mobile-first app) under /app with SPA fallback for client routes.
  if (req.method === 'GET' && (url.pathname === '/app' || url.pathname.startsWith('/app/'))) {
    const relative = normalize(url.pathname.replace(/^\/app\/?/, '')).replace(/^([.][.][\\/])+/, '');
    const candidate = relative ? join(PWA_DIR, relative) : join(PWA_DIR, 'index.html');
    if (!candidate.startsWith(PWA_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        await serveStaticFile(res, candidate);
        return;
      }
    } catch {
      // Fall through to the SPA index for client-side routes.
    }
    await serveStaticFile(res, join(PWA_DIR, 'index.html'));
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

async function start(): Promise<void> {
  await metrics.loadSnapshot();
  metrics.startPeriodicSnapshot();
  server.listen(PORT, () => {
    console.log(`Swiss Shopping Web UI running at http://localhost:${PORT}`);
  });
}

if (process.argv[1]) {
  void start();
}

export { server, start };
