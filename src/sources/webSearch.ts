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
 */

export interface WebSearchResult {
  url: string;
  title?: string;
  rank: number;
}

export type WebSearchProviderName = 'google' | 'ddg';

export interface WebSearchOptions {
  /** Site restriction, may include a path prefix (e.g. "migros.ch/de/product"). */
  site: string;
  limit?: number;
}

export interface WebSearchProvider {
  readonly name: WebSearchProviderName;
  search(query: string, options: WebSearchOptions): Promise<WebSearchResult[]>;
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
      // Do not include the request URL in errors: it contains the API key.
      throw new Error(`Google Custom Search request failed with status ${response.status}`);
    }

    const data = (await response.json()) as GoogleCseResponse;
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
      throw new Error(
        'DuckDuckGo bot challenge (HTTP 202) — keyless web search is temporarily rate-limited. Configure GOOGLE_CSE_API_KEY/GOOGLE_CSE_CX for reliable semantic search.'
      );
    }
    if (!response.ok) {
      throw new Error(`DuckDuckGo HTML search failed with status ${response.status} for ${url}`);
    }

    const html = await response.text();
    if (html.includes('anomaly-modal') || html.includes('challenge-form')) {
      throw new Error(
        'DuckDuckGo bot challenge page returned — keyless web search is temporarily rate-limited. Configure GOOGLE_CSE_API_KEY/GOOGLE_CSE_CX for reliable semantic search.'
      );
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

/**
 * Create the web-search provider from environment configuration.
 *
 * SWISS_SHOPPING_WEB_SEARCH=auto|google|ddg|off (default auto)
 * - auto: Google Custom Search when GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX are
 *   set, otherwise the keyless DuckDuckGo fallback.
 * - google: requires the keys; returns undefined (disabled) when missing.
 * - ddg: always available.
 * - off: disabled.
 */
export function createWebSearchProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch
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

  // auto
  if (hasGoogleKeys) {
    return new GoogleCustomSearchProvider({ apiKey: apiKey!, cx: cx!, fetchImpl });
  }
  return new DuckDuckGoHtmlProvider({ fetchImpl });
}
