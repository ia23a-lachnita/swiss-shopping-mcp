/**
 * Web-search layer for semantic product discovery.
 *
 * Vendor on-site search APIs are literal keyword matchers; general web search
 * engines understand synonyms and cross-language queries far better. This
 * module issues site-restricted queries (e.g. `site:migros.ch/de/product
 * zahncreme empfindliche zaehne`) and returns ranked result URLs, which the
 * WebProductSearchService maps back to vendor product IDs for hydration.
 *
 * Providers:
 * - GoogleCustomSearchProvider: official Google Programmable Search JSON API.
 *   Requires GOOGLE_CSE_API_KEY and GOOGLE_CSE_CX (100 free queries/day).
 *   NOTE: Google CSE is CLOSED to new customers (verified 2026-07-13).
 * - SerpApiProvider: SerpAPI Google search (free tier 250/month).
 * - HasDataProvider: HasData Google SERP API (1000 credits/month).
 * - SearloProvider: Searlo web search API (3000 credits/90 days).
 * - FirecrawlSearchProvider: Firecrawl search API (1000 credits/month).
 * - DuckDuckGoHtmlProvider: keyless fallback scraping the JS-free
 *   html.duckduckgo.com endpoint (Bing-backed index).
 * - CompositeWebSearchProvider: failover provider that tries providers in
 *   quality/scarcity order, integrates circuit breakers, and enforces
 *   per-provider daily budgets.
 */

import { SourceCircuitBreaker } from '../services/sourceCircuitBreaker.js';
import type { MetricsCollector } from '../util/metrics.js';

export interface WebSearchResult {
  url: string;
  title?: string;
  rank: number;
}

export type WebSearchProviderName =
  | 'google'
  | 'ddg'
  | 'serpapi'
  | 'hasdata'
  | 'searlo'
  | 'firecrawl'
  | 'composite';

export interface WebSearchOptions {
  /** Site restriction, may include a path prefix (e.g. "migros.ch/de/product"). */
  site: string;
  /** Multiple sites for aggregated search — when present, result URLs are matched against ANY of these. */
  sites?: string[];
  limit?: number;
}

export interface WebSearchProvider {
  readonly name: WebSearchProviderName;
  search(query: string, options: WebSearchOptions): Promise<WebSearchResult[]>;
}

// ---------------------------------------------------------------------------
// Typed error classification
// ---------------------------------------------------------------------------

export class TypedWebSearchError extends Error {
  public readonly retryable: boolean;
  public readonly provider: WebSearchProviderName;
  public readonly httpStatus?: number;

  public constructor(options: {
    message: string;
    provider: WebSearchProviderName;
    retryable: boolean;
    httpStatus?: number;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = 'TypedWebSearchError';
    this.provider = options.provider;
    this.retryable = options.retryable;
    this.httpStatus = options.httpStatus;
  }
}

const DEFAULT_RESULT_LIMIT = 10;
const REQUEST_TIMEOUT_MS = 8_000;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Host portion of a site restriction ("migros.ch/de/product" -> "migros.ch"). */
export function siteHost(site: string): string {
  return site.split('/')[0].toLowerCase();
}

function hostMatchesSite(url: URL, site: string): boolean {
  const host = siteHost(site);
  const hostname = url.hostname.toLowerCase();
  return hostname === host || hostname.endsWith(`.${host}`);
}

function hostMatchesSites(url: URL, sites: string[]): boolean {
  return sites.some((s) => hostMatchesSite(url, s));
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function classifyHttpError(
  status: number,
  provider: WebSearchProviderName,
  credentialHint?: string,
): TypedWebSearchError {
  if (status === 401 || status === 403) {
    return new TypedWebSearchError({
      message: `${provider} credentials rejected (HTTP ${status}).${credentialHint ? ` Check ${credentialHint}.` : ''}`,
      provider,
      retryable: false,
      httpStatus: status,
    });
  }
  if (status === 429) {
    return new TypedWebSearchError({
      message: `${provider} rate-limited (HTTP 429).`,
      provider,
      retryable: true,
      httpStatus: status,
    });
  }
  if (status >= 500) {
    return new TypedWebSearchError({
      message: `${provider} server error (HTTP ${status}).`,
      provider,
      retryable: true,
      httpStatus: status,
    });
  }
  return new TypedWebSearchError({
    message: `${provider} request failed with status ${status}.`,
    provider,
    retryable: false,
    httpStatus: status,
  });
}

// ---------------------------------------------------------------------------
// Google Custom Search Provider
// ---------------------------------------------------------------------------

export interface GoogleCustomSearchProviderOptions {
  apiKey: string;
  cx: string;
  fetchImpl?: typeof fetch;
}

interface GoogleCseResponse {
  items?: Array<{ link?: string; title?: string }>;
}

export class GoogleCustomSearchProvider implements WebSearchProvider {
  public readonly name = 'google' as const;
  private readonly apiKey: string;
  private readonly cx: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: GoogleCustomSearchProviderOptions) {
    this.apiKey = options.apiKey;
    this.cx = options.cx;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async search(query: string, options: WebSearchOptions): Promise<WebSearchResult[]> {
    const limit = Math.min(options.limit ?? DEFAULT_RESULT_LIMIT, 10);
    const q = `site:${options.site} ${query}`;
    const url =
      'https://www.googleapis.com/customsearch/v1' +
      `?key=${encodeURIComponent(this.apiKey)}` +
      `&cx=${encodeURIComponent(this.cx)}` +
      `&q=${encodeURIComponent(q)}` +
      `&num=${limit}&gl=ch`;

    const response = await fetchWithTimeout(this.fetchImpl, url, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw classifyHttpError(response.status, 'google', 'GOOGLE_CSE_API_KEY / GOOGLE_CSE_CX');
    }

    const data = (await response.json()) as GoogleCseResponse;

    // Check for quota-exceeded error in the response body
    if (
      typeof data === 'object' && data !== null &&
      'error' in data && typeof (data as Record<string, unknown>).error === 'object'
    ) {
      const errObj = (data as Record<string, { code?: number; message?: string }>).error;
      if (errObj?.code === 429 || (errObj?.message ?? '').toLowerCase().includes('quota')) {
        throw new TypedWebSearchError({
          message: `Google Custom Search quota exceeded.`,
          provider: 'google',
          retryable: true,
        });
      }
    }

    const items = Array.isArray(data.items) ? data.items : [];

    const results: WebSearchResult[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (typeof item.link !== 'string') continue;
      let parsed: URL;
      try {
        parsed = new URL(item.link);
      } catch {
        continue;
      }
      if (options.sites) {
        if (!hostMatchesSites(parsed, options.sites)) continue;
      } else {
        if (!hostMatchesSite(parsed, options.site)) continue;
      }
      if (seen.has(parsed.href)) continue;
      seen.add(parsed.href);
      results.push({ url: parsed.href, title: item.title, rank: results.length });
      if (results.length >= limit) break;
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// SerpAPI Provider
// ---------------------------------------------------------------------------

export interface SerpApiProviderOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

interface SerpApiOrganicResult {
  link?: string;
  title?: string;
  snippet?: string;
}

interface SerpApiResponse {
  organic_results?: SerpApiOrganicResult[];
  search_information?: Record<string, unknown>;
  error?: string;
}

export class SerpApiProvider implements WebSearchProvider {
  public readonly name = 'serpapi' as const;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: SerpApiProviderOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async search(query: string, options: WebSearchOptions): Promise<WebSearchResult[]> {
    const limit = Math.min(options.limit ?? DEFAULT_RESULT_LIMIT, 10);
    const q = `site:${options.site} ${query}`;
    const url =
      'https://serpapi.com/search' +
      `?engine=google` +
      `&q=${encodeURIComponent(q)}` +
      `&num=${limit}` +
      `&gl=ch&hl=de` +
      `&api_key=${encodeURIComponent(this.apiKey)}`;

    const response = await fetchWithTimeout(this.fetchImpl, url, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw classifyHttpError(response.status, 'serpapi', 'SERP_API_KEY');
    }

    let data: SerpApiResponse;
    try {
      data = (await response.json()) as SerpApiResponse;
    } catch {
      throw new TypedWebSearchError({
        message: 'SerpAPI returned a malformed (non-JSON) response body.',
        provider: 'serpapi',
        retryable: false,
      });
    }

    if (typeof data === 'object' && data !== null && typeof data.error === 'string' && data.error.length > 0) {
      const errLower = data.error.toLowerCase();
      // SerpAPI returns HTTP 200 + error for legitimately empty searches
      if (errLower.includes("hasn't returned any results") || errLower.includes('no results')) {
        return [];
      }
      const isRetryable = errLower.includes('rate limit') || errLower.includes('run out of searches');
      throw new TypedWebSearchError({
        message: `SerpAPI error: ${data.error}`,
        provider: 'serpapi',
        retryable: isRetryable,
      });
    }

    const items = Array.isArray(data.organic_results) ? data.organic_results : [];

    const results: WebSearchResult[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (typeof item.link !== 'string') continue;
      let parsed: URL;
      try {
        parsed = new URL(item.link);
      } catch {
        continue;
      }
      if (options.sites) {
        if (!hostMatchesSites(parsed, options.sites)) continue;
      } else {
        if (!hostMatchesSite(parsed, options.site)) continue;
      }
      if (seen.has(parsed.href)) continue;
      seen.add(parsed.href);
      results.push({ url: parsed.href, title: item.title, rank: results.length });
      if (results.length >= limit) break;
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// HasData Provider
// ---------------------------------------------------------------------------

export interface HasDataProviderOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

interface HasDataOrganicResult {
  link?: string;
  title?: string;
  snippet?: string;
}

interface HasDataResponse {
  organicResults?: HasDataOrganicResult[];
  requestMetadata?: Record<string, unknown>;
  searchInformation?: Record<string, unknown>;
  error?: string;
  message?: string;
}

export class HasDataProvider implements WebSearchProvider {
  public readonly name = 'hasdata' as const;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: HasDataProviderOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async search(query: string, options: WebSearchOptions): Promise<WebSearchResult[]> {
    const limit = Math.min(options.limit ?? DEFAULT_RESULT_LIMIT, 10);
    const q = `site:${options.site} ${query}`;
    const url =
      'https://api.hasdata.com/scrape/google/serp' +
      `?q=${encodeURIComponent(q)}` +
      `&gl=ch&hl=de`;

    const response = await fetchWithTimeout(this.fetchImpl, url, {
      headers: {
        Accept: 'application/json',
        'x-api-key': this.apiKey,
      },
    });
    if (!response.ok) {
      throw classifyHttpError(response.status, 'hasdata', 'HASDATA_API_KEY');
    }

    let data: HasDataResponse;
    try {
      data = (await response.json()) as HasDataResponse;
    } catch {
      throw new TypedWebSearchError({
        message: 'HasData returned a malformed (non-JSON) response body.',
        provider: 'hasdata',
        retryable: false,
      });
    }

    if (typeof data === 'object' && data !== null) {
      if (typeof data.error === 'string' && data.error.length > 0) {
        throw new TypedWebSearchError({
          message: `HasData error: ${data.error}`,
          provider: 'hasdata',
          retryable: false,
        });
      }
      if (typeof data.message === 'string' && data.message.length > 0) {
        throw new TypedWebSearchError({
          message: `HasData error: ${data.message}`,
          provider: 'hasdata',
          retryable: false,
        });
      }
    }

    const items = Array.isArray(data.organicResults) ? data.organicResults : [];

    const results: WebSearchResult[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (typeof item.link !== 'string') continue;
      let parsed: URL;
      try {
        parsed = new URL(item.link);
      } catch {
        continue;
      }
      if (options.sites) {
        if (!hostMatchesSites(parsed, options.sites)) continue;
      } else {
        if (!hostMatchesSite(parsed, options.site)) continue;
      }
      if (seen.has(parsed.href)) continue;
      seen.add(parsed.href);
      results.push({ url: parsed.href, title: item.title, rank: results.length });
      if (results.length >= limit) break;
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Searlo Provider
// ---------------------------------------------------------------------------

export interface SearloProviderOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

interface SearloOrganicResult {
  position?: number;
  title?: string;
  link?: string;
  snippet?: string;
}

interface SearloResponse {
  searchParameters?: Record<string, unknown>;
  page?: number;
  totalResults?: number;
  organic?: SearloOrganicResult[];
  success?: boolean;
  message?: string;
}

export class SearloProvider implements WebSearchProvider {
  public readonly name = 'searlo' as const;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: SearloProviderOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async search(query: string, options: WebSearchOptions): Promise<WebSearchResult[]> {
    const limit = Math.min(options.limit ?? DEFAULT_RESULT_LIMIT, 10);
    const q = `site:${options.site} ${query}`;
    const url =
      'https://api.searlo.tech/api/v1/search/web' +
      `?q=${encodeURIComponent(q)}` +
      `&limit=${limit}` +
      `&gl=ch&hl=de`;

    const response = await fetchWithTimeout(this.fetchImpl, url, {
      headers: {
        Accept: 'application/json',
        'x-api-key': this.apiKey,
      },
    });
    if (!response.ok) {
      throw classifyHttpError(response.status, 'searlo', 'SEARLO_API_KEY');
    }

    let data: SearloResponse;
    try {
      data = (await response.json()) as SearloResponse;
    } catch {
      throw new TypedWebSearchError({
        message: 'Searlo returned a malformed (non-JSON) response body.',
        provider: 'searlo',
        retryable: false,
      });
    }

    if (typeof data === 'object' && data !== null) {
      if (data.success === false && typeof data.message === 'string') {
        throw new TypedWebSearchError({
          message: `Searlo error: ${data.message}`,
          provider: 'searlo',
          retryable: false,
        });
      }
    }

    const items = Array.isArray(data.organic) ? data.organic : [];

    const results: WebSearchResult[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (typeof item.link !== 'string') continue;
      let parsed: URL;
      try {
        parsed = new URL(item.link);
      } catch {
        continue;
      }
      if (options.sites) {
        if (!hostMatchesSites(parsed, options.sites)) continue;
      } else {
        if (!hostMatchesSite(parsed, options.site)) continue;
      }
      if (seen.has(parsed.href)) continue;
      seen.add(parsed.href);
      results.push({ url: parsed.href, title: item.title, rank: results.length });
      if (results.length >= limit) break;
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Firecrawl Search Provider
// ---------------------------------------------------------------------------

export interface FirecrawlSearchProviderOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

interface FirecrawlWebResult {
  url?: string;
  title?: string;
  description?: string;
}

interface FirecrawlResponse {
  success?: boolean;
  data?: { web?: FirecrawlWebResult[] };
  error?: string;
}

export class FirecrawlSearchProvider implements WebSearchProvider {
  public readonly name = 'firecrawl' as const;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: FirecrawlSearchProviderOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async search(query: string, options: WebSearchOptions): Promise<WebSearchResult[]> {
    const limit = Math.min(options.limit ?? DEFAULT_RESULT_LIMIT, 10);
    const q = `site:${options.site} ${query}`;
    const url = 'https://api.firecrawl.dev/v2/search';

    const response = await fetchWithTimeout(this.fetchImpl, url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ query: q, limit }),
    });
    if (!response.ok) {
      throw classifyHttpError(response.status, 'firecrawl', 'FIRECRAWL_API_KEY');
    }

    let data: FirecrawlResponse;
    try {
      data = (await response.json()) as FirecrawlResponse;
    } catch {
      throw new TypedWebSearchError({
        message: 'Firecrawl returned a malformed (non-JSON) response body.',
        provider: 'firecrawl',
        retryable: false,
      });
    }

    if (typeof data === 'object' && data !== null) {
      if (data.success === false && typeof data.error === 'string') {
        throw new TypedWebSearchError({
          message: `Firecrawl error: ${data.error}`,
          provider: 'firecrawl',
          retryable: false,
        });
      }
    }

    const items = Array.isArray(data.data?.web) ? data.data!.web! : [];

    const results: WebSearchResult[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (typeof item.url !== 'string') continue;
      let parsed: URL;
      try {
        parsed = new URL(item.url);
      } catch {
        continue;
      }
      if (options.sites) {
        if (!hostMatchesSites(parsed, options.sites)) continue;
      } else {
        if (!hostMatchesSite(parsed, options.site)) continue;
      }
      if (seen.has(parsed.href)) continue;
      seen.add(parsed.href);
      results.push({ url: parsed.href, title: item.title, rank: results.length });
      if (results.length >= limit) break;
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// DuckDuckGo HTML Provider
// ---------------------------------------------------------------------------

export interface DuckDuckGoHtmlProviderOptions {
  fetchImpl?: typeof fetch;
  /** Minimum spacing between requests; parallel bursts trigger DDG's bot challenge. */
  minIntervalMs?: number;
}

const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';
const ANCHOR_PATTERN = /<a\s+[^>]*>/gi;
const HREF_PATTERN = /href="([^"]+)"/i;
const CLASS_PATTERN = /class="([^"]*)"/i;

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

/**
 * Resolve a DuckDuckGo result href to its target URL.
 * Organic results use redirect links: //duckduckgo.com/l/?uddg=<encoded>&rut=…
 * Ad results decode to duckduckgo.com/y.js or bing.com click trackers.
 */
export function resolveDuckDuckGoHref(rawHref: string): URL | undefined {
  const href = decodeHtmlEntities(rawHref);
  let parsed: URL;
  try {
    parsed = new URL(href.startsWith('//') ? `https:${href}` : href, DDG_ENDPOINT);
  } catch {
    return undefined;
  }

  if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname.startsWith('/l/')) {
    const target = parsed.searchParams.get('uddg');
    if (!target) return undefined;
    try {
      parsed = new URL(target);
    } catch {
      return undefined;
    }
  }

  // Ads resolve to search-engine click trackers rather than the target site.
  const hostname = parsed.hostname.toLowerCase();
  if (hostname.endsWith('duckduckgo.com') || hostname.endsWith('bing.com')) {
    return undefined;
  }
  return parsed;
}

export function parseDuckDuckGoHtml(html: string, site: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(ANCHOR_PATTERN)) {
    const anchor = match[0];
    const classMatch = anchor.match(CLASS_PATTERN);
    if (!classMatch || !classMatch[1].split(/\s+/).includes('result__a')) continue;
    const hrefMatch = anchor.match(HREF_PATTERN);
    if (!hrefMatch) continue;

    const target = resolveDuckDuckGoHref(hrefMatch[1]);
    if (!target) continue;
    if (!hostMatchesSite(target, site)) continue;
    if (seen.has(target.href)) continue;
    seen.add(target.href);
    results.push({ url: target.href, rank: results.length });
    if (results.length >= limit) break;
  }

  return results;
}

export class DuckDuckGoHtmlProvider implements WebSearchProvider {
  public readonly name = 'ddg' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly minIntervalMs: number;
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  public constructor(options: DuckDuckGoHtmlProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.minIntervalMs = options.minIntervalMs ?? 1_500;
  }

  /** Serialize requests with a minimum interval between them. */
  private throttle(): Promise<void> {
    const run = this.queue.then(async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      this.lastRequestAt = Date.now();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  public async search(query: string, options: WebSearchOptions): Promise<WebSearchResult[]> {
    await this.throttle();
    const limit = options.limit ?? DEFAULT_RESULT_LIMIT;
    const q = `site:${options.site} ${query}`;
    const url = `${DDG_ENDPOINT}?q=${encodeURIComponent(q)}`;

    const response = await fetchWithTimeout(this.fetchImpl, url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
      },
    });
    // DuckDuckGo rate-limits automated clients with an HTTP 202 challenge page.
    if (response.status === 202) {
      throw new TypedWebSearchError({
        message:
          'DuckDuckGo bot challenge (HTTP 202) — keyless web search is temporarily rate-limited.',
        provider: 'ddg',
        retryable: true,
        httpStatus: 202,
      });
    }
    if (!response.ok) {
      throw new TypedWebSearchError({
        message: `DuckDuckGo HTML search failed with status ${response.status}.`,
        provider: 'ddg',
        retryable: response.status >= 500,
        httpStatus: response.status,
      });
    }

    const html = await response.text();
    if (html.includes('anomaly-modal') || html.includes('challenge-form')) {
      throw new TypedWebSearchError({
        message:
          'DuckDuckGo bot challenge page returned — keyless web search is temporarily rate-limited.',
        provider: 'ddg',
        retryable: true,
      });
    }
    return parseDuckDuckGoHtml(html, options.site, limit);
  }
}

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

export type WebSearchMode =
  | 'auto'
  | 'google'
  | 'ddg'
  | 'serpapi'
  | 'hasdata'
  | 'searlo'
  | 'firecrawl'
  | 'off';

const PROVIDER_MODE_NAMES: readonly WebSearchMode[] = [
  'google', 'ddg', 'serpapi', 'hasdata', 'searlo', 'firecrawl',
];

export function resolveWebSearchMode(env: NodeJS.ProcessEnv = process.env): WebSearchMode {
  const raw = env.SWISS_SHOPPING_WEB_SEARCH;
  if (raw === 'off' || (PROVIDER_MODE_NAMES as readonly string[]).includes(raw ?? '')) {
    return raw as WebSearchMode;
  }
  return 'auto';
}

// ---------------------------------------------------------------------------
// Composite / failover provider with circuit breakers + budget
// ---------------------------------------------------------------------------

export interface CompositeProviderEntry {
  provider: WebSearchProvider;
  breaker: SourceCircuitBreaker;
  budget?: import('../cache/providerBudget.js').ProviderBudget;
}

export interface CompositeWebSearchProviderOptions {
  /** Ordered chain of providers with per-provider breaker and budget. */
  chain?: CompositeProviderEntry[];
  /** Legacy primary field — used when chain is empty. */
  primary?: WebSearchProvider;
  /** Legacy fallback field — used when chain is empty. */
  fallback?: WebSearchProvider;
  /** Legacy single breaker — used when chain is empty. */
  breaker?: import('../services/sourceCircuitBreaker.js').SourceCircuitBreaker;
  /** Legacy single budget — used when chain is empty. */
  budget?: import('../cache/providerBudget.js').ProviderBudget;
  onMetric?: (metric: WebSearchMetric) => void;
  /** Shared collector for per-provider request/fallback/circuit-breaker metrics. */
  metrics?: MetricsCollector;
  clock?: { now(): Date };
}

export interface WebSearchMetric {
  type: 'attempt' | 'success' | 'fallback_attempt' | 'fallback_success' | 'budget_skip' | 'breaker_skip';
  provider: WebSearchProviderName;
  query?: string;
  elapsedMs?: number;
  error?: string;
  retryable?: boolean;
}

/**
 * Failover web search provider: tries providers in quality/scarcity order,
 * falls back to the next provider on retryable errors. Integrates circuit
 * breakers (skip entirely when open) and daily per-provider budgets
 * (skip when exhausted).
 *
 * NON-retryable errors (invalid credentials 401/403, programming errors)
 * are surfaced immediately — no fallback.
 */
export class CompositeWebSearchProvider implements WebSearchProvider {
  public readonly name = 'composite' as const;
  private readonly chain: CompositeProviderEntry[];
  private readonly onMetric?: (metric: WebSearchMetric) => void;
  private readonly metrics?: MetricsCollector;
  private readonly clock: { now(): Date };

  public constructor(options: CompositeWebSearchProviderOptions) {
    // Support legacy primary/fallback pattern by converting to chain
    if (options.chain && options.chain.length > 0) {
      this.chain = options.chain;
    } else {
      const entries: CompositeProviderEntry[] = [];
      const breaker = options.breaker ?? new SourceCircuitBreaker({
        failureThreshold: 3,
        cooldownMs: 5 * 60_000,
      });
      if (options.primary) {
        entries.push({ provider: options.primary, breaker, budget: options.budget });
      }
      if (options.fallback) {
        entries.push({ provider: options.fallback, breaker, budget: options.budget });
      }
      this.chain = entries;
    }
    this.onMetric = options.onMetric;
    this.metrics = options.metrics;
    this.clock = options.clock ?? { now: (): Date => new Date() };
  }

  public async search(query: string, options: WebSearchOptions): Promise<WebSearchResult[]> {
    return this.searchWithFailover(query, options, [options.site]);
  }

  /**
   * Aggregated multi-site search: issues one query with multiple site:
   * OR-groups and returns all results. Providers that support site: operators
   * (all except DDG) get a single aggregated query. DDG falls back to
   * serialized individual queries. Results include the matched site
   * for grouping by retailer.
   */
  public async searchAggregated(
    query: string,
    sites: string[],
    limit?: number,
  ): Promise<WebSearchResult[]> {
    if (sites.length === 0) return [];
    if (sites.length === 1) {
      return this.searchWithFailover(query, { site: sites[0], limit }, sites);
    }

    let lastFailedProvider: WebSearchProviderName | undefined;

    // Try each provider in the chain with aggregated multi-site query
    for (const entry of this.chain) {
      const providerName = entry.provider.name;

      if (!this.canUseProvider(entry, sites)) continue;

      this.metrics?.recordProviderRequest(providerName);

      // DDG doesn't support site: OR — serialize individual queries
      if (providerName === 'ddg') {
        const allResults: WebSearchResult[] = [];
        let anyFailed = false;
        for (const site of sites) {
          try {
            const start = this.clock.now().getTime();
            const results = await entry.provider.search(query, { site, limit });
            this.recordSuccess(entry, start);
            allResults.push(...results);
          } catch (error) {
            this.recordFailure(entry, error);
            if (!isRetryableError(error)) {
              throw error;
            }
            lastFailedProvider = providerName;
            anyFailed = true;
          }
        }
        if (allResults.length > 0 || !anyFailed) {
          if (lastFailedProvider) {
            this.metrics?.recordProviderFallbackFrom(lastFailedProvider);
          }
          return allResults;
        }
        continue;
      }

      // All other providers support aggregated site: OR query
      try {
        const start = this.clock.now().getTime();
        const results = await entry.provider.search(query, {
          site: sites.join(' OR site:'),
          sites,
          limit,
        });
        this.recordSuccess(entry, start);
        if (lastFailedProvider) {
          this.metrics?.recordProviderFallbackFrom(lastFailedProvider);
        }
        return results;
      } catch (error) {
        this.recordFailure(entry, error);
        if (!isRetryableError(error)) {
          throw error;
        }
        lastFailedProvider = providerName;
      }
    }

    return [];
  }

  private async searchWithFailover(
    query: string,
    options: WebSearchOptions,
    sites: string[],
  ): Promise<WebSearchResult[]> {
    const errors: TypedWebSearchError[] = [];
    let lastFailedProvider: WebSearchProviderName | undefined;

    for (let i = 0; i < this.chain.length; i++) {
      const entry = this.chain[i];
      const providerName = entry.provider.name;

      if (!this.canUseProvider(entry, sites)) continue;

      this.metrics?.recordProviderRequest(providerName);

      try {
        const start = this.clock.now().getTime();
        const results = await entry.provider.search(query, options);
        this.recordSuccess(entry, start);
        if (lastFailedProvider) {
          this.metrics?.recordProviderFallbackFrom(lastFailedProvider);
        }
        return results;
      } catch (error) {
        this.recordFailure(entry, error);
        if (!isRetryableError(error)) {
          throw error;
        }
        lastFailedProvider = providerName;
        errors.push(asTypedError(error, providerName));
      }
    }

    if (errors.length > 0) {
      throw errors[errors.length - 1];
    }
    return [];
  }

  private canUseProvider(entry: CompositeProviderEntry, _sites: string[]): boolean {
    const providerName = entry.provider.name;

    if (entry.breaker.isOpen(providerName)) {
      this.onMetric?.({ type: 'breaker_skip', provider: providerName });
      this.metrics?.recordCircuitBreakerOpen();
      return false;
    }

    if (entry.budget) {
      if (entry.budget.isExhausted(providerName) || entry.budget.isLow(providerName)) {
        this.onMetric?.({ type: 'budget_skip', provider: providerName });
        return false;
      }
    }

    return true;
  }

  private recordSuccess(entry: CompositeProviderEntry, startMs: number): void {
    const providerName = entry.provider.name;
    entry.breaker.recordSuccess(providerName);
    entry.budget?.recordRequest(providerName);
    this.onMetric?.({
      type: 'success',
      provider: providerName,
      elapsedMs: this.clock.now().getTime() - startMs,
    });
  }

  private recordFailure(entry: CompositeProviderEntry, error: unknown): void {
    const providerName = entry.provider.name;
    if (isRetryableError(error)) {
      entry.breaker.recordFailure(providerName);
    }
    entry.budget?.recordFailure(providerName);
    this.onMetric?.({
      type: 'attempt',
      provider: providerName,
      error: error instanceof Error ? error.message : String(error),
      retryable: isRetryableError(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function isRetryableError(error: unknown): boolean {
  if (error instanceof TypedWebSearchError) return error.retryable;
  // Timeout / AbortError → retryable
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return true;
  }
  // Unknown errors are treated as non-retryable (programming errors)
  return false;
}

function asTypedError(error: unknown, provider: WebSearchProviderName): TypedWebSearchError {
  if (error instanceof TypedWebSearchError) return error;
  return new TypedWebSearchError({
    message: error instanceof Error ? error.message : String(error),
    provider,
    retryable: isRetryableError(error),
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the web-search provider from environment configuration.
 *
 * SWISS_SHOPPING_WEB_SEARCH=auto|google|ddg|serpapi|hasdata|searlo|firecrawl|off (default auto)
 * - auto: CompositeWebSearchProvider with all configured providers in quality/scarcity order.
 * - google: requires the keys; returns undefined (disabled) when missing.
 * - ddg: always available (single DDG provider).
 * - serpapi/hasdata/searlo/firecrawl: requires the corresponding key; returns undefined when missing.
 * - off: disabled.
 */
export function createWebSearchProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
  breaker?: import('../services/sourceCircuitBreaker.js').SourceCircuitBreaker,
  budget?: import('../cache/providerBudget.js').ProviderBudget,
  onMetric?: (metric: WebSearchMetric) => void,
  metrics?: MetricsCollector,
): WebSearchProvider | undefined {
  const mode = resolveWebSearchMode(env);
  if (mode === 'off') return undefined;

  // Single-provider modes
  if (mode === 'google') {
    const apiKey = env.GOOGLE_CSE_API_KEY;
    const cx = env.GOOGLE_CSE_CX ?? env.GOOGLE_CSE_ID;
    if (!(typeof apiKey === 'string' && apiKey.length > 0 && typeof cx === 'string' && cx.length > 0)) {
      return undefined;
    }
    return new GoogleCustomSearchProvider({ apiKey, cx, fetchImpl });
  }

  if (mode === 'ddg') {
    return new DuckDuckGoHtmlProvider({ fetchImpl });
  }

  if (mode === 'serpapi') {
    const key = env.SERP_API_KEY;
    if (!(typeof key === 'string' && key.length > 0)) return undefined;
    return new SerpApiProvider({ apiKey: key, fetchImpl });
  }

  if (mode === 'hasdata') {
    const key = env.HASDATA_API_KEY;
    if (!(typeof key === 'string' && key.length > 0)) return undefined;
    return new HasDataProvider({ apiKey: key, fetchImpl });
  }

  if (mode === 'searlo') {
    const key = env.SEARLO_API_KEY;
    if (!(typeof key === 'string' && key.length > 0)) return undefined;
    return new SearloProvider({ apiKey: key, fetchImpl });
  }

  if (mode === 'firecrawl') {
    const key = env.FIRECRAWL_API_KEY;
    if (!(typeof key === 'string' && key.length > 0)) return undefined;
    return new FirecrawlSearchProvider({ apiKey: key, fetchImpl });
  }

  // auto mode: build composite chain from all configured providers
  return buildAutoComposite(env, fetchImpl, breaker, budget, onMetric, metrics);
}

/**
 * Build the auto-mode composite provider chain.
 * Order: serpapi → hasdata → searlo → firecrawl → google (legacy) → ddg (emergency).
 */
function buildAutoComposite(
  env: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
  sharedBreaker?: import('../services/sourceCircuitBreaker.js').SourceCircuitBreaker,
  sharedBudget?: import('../cache/providerBudget.js').ProviderBudget,
  onMetric?: (metric: WebSearchMetric) => void,
  metrics?: MetricsCollector,
): WebSearchProvider | undefined {
  const clock = { now: (): Date => new Date() };
  const entries: CompositeProviderEntry[] = [];

  const defaultBreaker = (): SourceCircuitBreaker =>
    sharedBreaker ?? new SourceCircuitBreaker({ failureThreshold: 3, cooldownMs: 5 * 60_000 });

  // SerpAPI
  const serpapiKey = env.SERP_API_KEY;
  if (typeof serpapiKey === 'string' && serpapiKey.length > 0) {
    entries.push({
      provider: new SerpApiProvider({ apiKey: serpapiKey, fetchImpl }),
      breaker: defaultBreaker(),
      budget: sharedBudget,
    });
  }

  // HasData
  const hasdataKey = env.HASDATA_API_KEY;
  if (typeof hasdataKey === 'string' && hasdataKey.length > 0) {
    entries.push({
      provider: new HasDataProvider({ apiKey: hasdataKey, fetchImpl }),
      breaker: defaultBreaker(),
      budget: sharedBudget,
    });
  }

  // Searlo
  const searloKey = env.SEARLO_API_KEY;
  if (typeof searloKey === 'string' && searloKey.length > 0) {
    entries.push({
      provider: new SearloProvider({ apiKey: searloKey, fetchImpl }),
      breaker: defaultBreaker(),
      budget: sharedBudget,
    });
  }

  // Firecrawl
  const firecrawlKey = env.FIRECRAWL_API_KEY;
  if (typeof firecrawlKey === 'string' && firecrawlKey.length > 0) {
    entries.push({
      provider: new FirecrawlSearchProvider({ apiKey: firecrawlKey, fetchImpl }),
      breaker: defaultBreaker(),
      budget: sharedBudget,
    });
  }

  // Google (legacy — only if CSE keys present)
  const googleKey = env.GOOGLE_CSE_API_KEY;
  const googleCx = env.GOOGLE_CSE_CX ?? env.GOOGLE_CSE_ID;
  if (
    typeof googleKey === 'string' && googleKey.length > 0 &&
    typeof googleCx === 'string' && googleCx.length > 0
  ) {
    entries.push({
      provider: new GoogleCustomSearchProvider({ apiKey: googleKey, cx: googleCx, fetchImpl }),
      breaker: defaultBreaker(),
      budget: sharedBudget,
    });
  }

  // DDG always last (emergency fallback)
  entries.push({
    provider: new DuckDuckGoHtmlProvider({ fetchImpl }),
    breaker: defaultBreaker(),
  });

  if (entries.length === 0) return undefined;

  return new CompositeWebSearchProvider({ chain: entries, onMetric, metrics, clock });
}
