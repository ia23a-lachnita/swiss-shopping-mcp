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
 * - DuckDuckGoHtmlProvider: keyless fallback scraping the JS-free
 *   html.duckduckgo.com endpoint (Bing-backed index).
 * - CompositeWebSearchProvider: failover provider that tries Google first,
 *   falls back to DuckDuckGo on retryable errors, integrates circuit breakers,
 *   and enforces per-provider daily budgets.
 */

import { SourceCircuitBreaker } from '../services/sourceCircuitBreaker.js';

export interface WebSearchResult {
  url: string;
  title?: string;
  rank: number;
}

export type WebSearchProviderName = 'google' | 'ddg' | 'composite';

export interface WebSearchOptions {
  /** Site restriction, may include a path prefix (e.g. "migros.ch/de/product"). */
  site: string;
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
      const status = response.status;
      // Do not include the request URL in errors: it contains the API key.
      if (status === 401 || status === 403) {
        throw new TypedWebSearchError({
          message: `Google Custom Search credentials rejected (HTTP ${status}). Check GOOGLE_CSE_API_KEY / GOOGLE_CSE_CX.`,
          provider: 'google',
          retryable: false,
          httpStatus: status,
        });
      }
      if (status === 429) {
        throw new TypedWebSearchError({
          message: `Google Custom Search rate-limited (HTTP 429).`,
          provider: 'google',
          retryable: true,
          httpStatus: status,
        });
      }
      if (status >= 500) {
        throw new TypedWebSearchError({
          message: `Google Custom Search server error (HTTP ${status}).`,
          provider: 'google',
          retryable: true,
          httpStatus: status,
        });
      }
      throw new TypedWebSearchError({
        message: `Google Custom Search request failed with status ${status}.`,
        provider: 'google',
        retryable: false,
        httpStatus: status,
      });
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
      if (!hostMatchesSite(parsed, options.site)) continue;
      if (seen.has(parsed.href)) continue;
      seen.add(parsed.href);
      results.push({ url: parsed.href, title: item.title, rank: results.length });
      if (results.length >= limit) break;
    }
    return results;
  }
}

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

export type WebSearchMode = 'auto' | 'google' | 'ddg' | 'off';

export function resolveWebSearchMode(env: NodeJS.ProcessEnv = process.env): WebSearchMode {
  const raw = env.SWISS_SHOPPING_WEB_SEARCH;
  if (raw === 'google' || raw === 'ddg' || raw === 'off') {
    return raw;
  }
  return 'auto';
}

// ---------------------------------------------------------------------------
// Composite / failover provider with circuit breakers + budget
// ---------------------------------------------------------------------------

export interface CompositeWebSearchProviderOptions {
  primary?: WebSearchProvider;
  fallback?: WebSearchProvider;
  breaker?: import('../services/sourceCircuitBreaker.js').SourceCircuitBreaker;
  budget?: import('../cache/providerBudget.js').ProviderBudget;
  onMetric?: (metric: WebSearchMetric) => void;
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
 * Failover web search provider: tries primary (Google) first, falls back to
 * fallback (DDG) on retryable errors. Integrates circuit breakers (skip
 * entirely when open) and a daily per-provider budget (skip when exhausted).
 *
 * NON-retryable errors (invalid credentials 401/403, programming errors)
 * are surfaced immediately — no fallback.
 */
export class CompositeWebSearchProvider implements WebSearchProvider {
  public readonly name = 'composite' as const;
  private readonly primary?: WebSearchProvider;
  private readonly fallback?: WebSearchProvider;
  private readonly breaker: import('../services/sourceCircuitBreaker.js').SourceCircuitBreaker;
  private readonly budget?: import('../cache/providerBudget.js').ProviderBudget;
  private readonly onMetric?: (metric: WebSearchMetric) => void;
  private readonly clock: { now(): Date };

  public constructor(options: CompositeWebSearchProviderOptions = {}) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.breaker =
      options.breaker ??
      new SourceCircuitBreaker({
        failureThreshold: 3,
        cooldownMs: 5 * 60_000,
      });
    this.budget = options.budget;
    this.onMetric = options.onMetric;
    this.clock = options.clock ?? { now: (): Date => new Date() };
  }

  public async search(query: string, options: WebSearchOptions): Promise<WebSearchResult[]> {
    return this.searchWithFailover(query, options, [options.site]);
  }

  /**
   * Aggregated multi-site search: issues one query with multiple site:
   * OR-groups and returns all results. For DDG (which doesn't support site:
   * OR), individual queries are serialized. Results include the matched site
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

    const primaryCanAttempt = this.canUseProvider('google', sites);
    const fallbackCanAttempt = this.canUseProvider('ddg', sites);

    if (!primaryCanAttempt && !fallbackCanAttempt) {
      return [];
    }

    // Try primary with aggregated multi-site query
    if (primaryCanAttempt && this.primary) {
      try {
        const start = this.clock.now().getTime();
        const results = await this.primary.search(query, {
          site: sites.join(' OR site:'),
          limit,
        });
        this.recordSuccess('google', start);
        return results;
      } catch (error) {
        this.recordFailure('google', error);
        if (!isRetryableError(error)) {
          throw error;
        }
      }
    }

    // Fallback: serialize individual DDG queries per site
    if (fallbackCanAttempt && this.fallback) {
      const allResults: WebSearchResult[] = [];
      for (const site of sites) {
        try {
          const start = this.clock.now().getTime();
          const results = await this.fallback.search(query, { site, limit });
          this.recordSuccess('ddg', start);
          allResults.push(...results);
        } catch (error) {
          this.recordFailure('ddg', error);
          if (!isRetryableError(error)) {
            throw error;
          }
        }
      }
      return allResults;
    }

    return [];
  }

  private async searchWithFailover(
    query: string,
    options: WebSearchOptions,
    sites: string[],
  ): Promise<WebSearchResult[]> {
    const primaryCanAttempt = this.canUseProvider('google', sites);
    const fallbackCanAttempt = this.canUseProvider('ddg', sites);

    if (!primaryCanAttempt && !fallbackCanAttempt) {
      return [];
    }

    const errors: TypedWebSearchError[] = [];

    // Try primary first
    if (primaryCanAttempt && this.primary) {
      try {
        const start = this.clock.now().getTime();
        const results = await this.primary.search(query, options);
        this.recordSuccess('google', start);
        return results;
      } catch (error) {
        this.recordFailure('google', error);
        if (!isRetryableError(error)) {
          throw error;
        }
        errors.push(asTypedError(error, 'google'));
      }
    }

    // Try fallback
    if (fallbackCanAttempt && this.fallback) {
      try {
        const start = this.clock.now().getTime();
        const results = await this.fallback.search(query, options);
        this.recordSuccess('ddg', start);
        return results;
      } catch (error) {
        this.recordFailure('ddg', error);
        if (!isRetryableError(error)) {
          throw error;
        }
        errors.push(asTypedError(error, 'ddg'));
      }
    }

    if (errors.length > 0) {
      throw errors[errors.length - 1];
    }
    return [];
  }

  private canUseProvider(provider: WebSearchProviderName, _sites: string[]): boolean {
    if (provider === 'google' && !this.primary) return false;
    if (provider === 'ddg' && !this.fallback) return false;

    if (this.breaker.isOpen(provider)) {
      this.onMetric?.({ type: 'breaker_skip', provider });
      return false;
    }

    if (this.budget && provider === 'google') {
      if (this.budget.isExhausted('google') || this.budget.isLow('google')) {
        this.onMetric?.({ type: 'budget_skip', provider });
        return false;
      }
    }

    return true;
  }

  private recordSuccess(provider: WebSearchProviderName, startMs: number): void {
    this.breaker.recordSuccess(provider);
    this.budget?.recordRequest(provider);
    this.onMetric?.({
      type: 'success',
      provider,
      elapsedMs: this.clock.now().getTime() - startMs,
    });
  }

  private recordFailure(provider: WebSearchProviderName, error: unknown): void {
    if (isRetryableError(error)) {
      this.breaker.recordFailure(provider);
    }
    this.budget?.recordFailure(provider);
    this.onMetric?.({
      type: 'attempt',
      provider,
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
 * SWISS_SHOPPING_WEB_SEARCH=auto|google|ddg|off (default auto)
 * - auto: CompositeWebSearchProvider with Google (when keys present) + DDG.
 * - google: requires the keys; returns undefined (disabled) when missing.
 * - ddg: always available (single DDG provider).
 * - off: disabled.
 */
export function createWebSearchProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
  breaker?: import('../services/sourceCircuitBreaker.js').SourceCircuitBreaker,
  budget?: import('../cache/providerBudget.js').ProviderBudget,
  onMetric?: (metric: WebSearchMetric) => void,
): WebSearchProvider | undefined {
  const mode = resolveWebSearchMode(env);
  if (mode === 'off') return undefined;

  const apiKey = env.GOOGLE_CSE_API_KEY;
  const cx = env.GOOGLE_CSE_CX ?? env.GOOGLE_CSE_ID;
  const hasGoogleKeys = typeof apiKey === 'string' && apiKey.length > 0 && typeof cx === 'string' && cx.length > 0;

  if (mode === 'google') {
    if (!hasGoogleKeys) return undefined;
    return new GoogleCustomSearchProvider({ apiKey: apiKey!, cx: cx!, fetchImpl });
  }

  if (mode === 'ddg') {
    return new DuckDuckGoHtmlProvider({ fetchImpl });
  }

  // auto mode: use composite if Google keys are available, else DDG alone
  if (hasGoogleKeys) {
    return new CompositeWebSearchProvider({
      primary: new GoogleCustomSearchProvider({ apiKey: apiKey!, cx: cx!, fetchImpl }),
      fallback: new DuckDuckGoHtmlProvider({ fetchImpl }),
      breaker,
      budget,
      onMetric,
    });
  }
  return new DuckDuckGoHtmlProvider({ fetchImpl });
}
