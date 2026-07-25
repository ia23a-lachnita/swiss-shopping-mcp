import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  CompositeWebSearchProvider,
  createWebSearchProviderFromEnv,
  DuckDuckGoHtmlProvider,
  DuckDuckGoLiteProvider,
  GoogleCustomSearchProvider,
  SerpApiProvider,
  HasDataProvider,
  SearloProvider,
  FirecrawlSearchProvider,
  parseDuckDuckGoHtml,
  resolveDuckDuckGoHref,
  resolveWebSearchMode,
  siteHost,
  TypedWebSearchError,
  WebSearchResult,
  WebSearchProvider,
} from './webSearch.js';
import { SourceCircuitBreaker } from '../services/sourceCircuitBreaker.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html' },
  });
}

// Modeled on a real html.duckduckgo.com capture: ads are redirect links whose
// uddg target decodes to duckduckgo.com/y.js; organic results decode to the
// target site.
const DDG_FIXTURE = `
<div class="results">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dexample.com%26ad_provider%3Dbingv7aa&amp;rut=abc">Sponsored</a>
  <a rel="noopener" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.migros.ch%2Fde%2Fproduct%2F514160800000%3Fcontext%3Decommerce&amp;rut=def">Candida Sensitive</a>
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.migros.ch%2Fde%2Fproduct%2Fmo%2F106497&amp;rut=ghi">Online Only</a>
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.coop.ch%2Fde%2Fx%2Fp%2F123&amp;rut=jkl">Wrong site</a>
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.migros.ch%2Fde%2Fproduct%2F514160800000%3Fcontext%3Decommerce&amp;rut=dup">Duplicate</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.migros.ch%2Fde%2Fproduct%2F999999999999&amp;rut=mno">Snippet link ignored</a>
</div>`;

// Modeled on a real lite.duckduckgo.com capture (verified live 2026-07-25):
// table-based HTML4 layout, single-quoted class attrs, same //duckduckgo.com/l/
// redirect scheme as the html endpoint but a distinct result-link class.
const DDG_LITE_FIXTURE = `
<table border="0">
  <tr>
    <td valign="top">1.&nbsp;</td>
    <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.migros.ch%2Fde%2Fproduct%2F514160800000&amp;rut=def" class='result-link'>Candida Sensitive</a></td>
  </tr>
  <tr>
    <td valign="top">2.&nbsp;</td>
    <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.migros.ch%2Fde%2Fproduct%2Fmo%2F106497&amp;rut=ghi" class='result-link'>Online Only</a></td>
  </tr>
  <tr>
    <td valign="top">3.&nbsp;</td>
    <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.coop.ch%2Fde%2Fx%2Fp%2F123&amp;rut=jkl" class='result-link'>Wrong site</a></td>
  </tr>
</table>`;

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function mockProviderEntry(
  name: 'google' | 'ddg' | 'serpapi' | 'hasdata' | 'searlo' | 'firecrawl',
  results: WebSearchResult[],
  options: { failWith?: Error } = {},
) {
  return {
    provider: {
      name,
      search: vi.fn(async () => {
        if (options.failWith) throw options.failWith;
        return results;
      }),
    } as unknown as WebSearchProvider,
    breaker: new SourceCircuitBreaker({ failureThreshold: 5, cooldownMs: 60_000 }),
  };
}

describe('siteHost', () => {
  it('strips the path prefix from a site restriction', () => {
    expect(siteHost('migros.ch/de/product')).toBe('migros.ch');
    expect(siteHost('coop.ch')).toBe('coop.ch');
  });
});

describe('resolveDuckDuckGoHref', () => {
  it('decodes the uddg redirect parameter', () => {
    const url = resolveDuckDuckGoHref(
      '//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.migros.ch%2Fde%2Fproduct%2F514160800000&amp;rut=def'
    );
    expect(url?.href).toBe('https://www.migros.ch/de/product/514160800000');
  });

  it('rejects ad links that decode to search-engine click trackers', () => {
    const url = resolveDuckDuckGoHref(
      '//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dexample.com&amp;rut=abc'
    );
    expect(url).toBeUndefined();
  });
});

describe('parseDuckDuckGoHtml', () => {
  it('extracts organic result URLs for the requested site in rank order', () => {
    const results = parseDuckDuckGoHtml(DDG_FIXTURE, 'migros.ch/de/product', 10);
    expect(results.map((r) => r.url)).toEqual([
      'https://www.migros.ch/de/product/514160800000?context=ecommerce',
      'https://www.migros.ch/de/product/mo/106497',
    ]);
    expect(results.map((r) => r.rank)).toEqual([0, 1]);
  });

  it('respects the limit', () => {
    const results = parseDuckDuckGoHtml(DDG_FIXTURE, 'migros.ch', 1);
    expect(results).toHaveLength(1);
  });

  it('extracts results using an alternate link class (lite.duckduckgo.com shape)', () => {
    const results = parseDuckDuckGoHtml(DDG_LITE_FIXTURE, 'migros.ch/de/product', 10, 'result-link');
    expect(results.map((r) => r.url)).toEqual([
      'https://www.migros.ch/de/product/514160800000',
      'https://www.migros.ch/de/product/mo/106497',
    ]);
  });
});

describe('DuckDuckGoHtmlProvider', () => {
  it('fetches and parses site-restricted results', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse(DDG_FIXTURE));
    const provider = new DuckDuckGoHtmlProvider({ fetchImpl });

    const results = await provider.search('toothpaste sensitive', { site: 'migros.ch/de/product' });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const requestedUrl = fetchImpl.mock.calls[0][0] as string;
    expect(requestedUrl).toContain('html.duckduckgo.com');
    expect(requestedUrl).toContain(encodeURIComponent('site:migros.ch/de/product toothpaste sensitive'));
    expect(results).toHaveLength(2);
  });

  it('throws on non-200 responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse('blocked', 403));
    const provider = new DuckDuckGoHtmlProvider({ fetchImpl });

    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toThrow('403');
  });

  it('throws on the HTTP 202 bot challenge instead of returning zero results', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse('challenge', 202));
    const provider = new DuckDuckGoHtmlProvider({ fetchImpl });

    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toThrow(/bot challenge/);
  });

  it('throws when a 200 response contains the anomaly challenge page', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(htmlResponse('<div class="anomaly-modal__mask"></div>', 200));
    const provider = new DuckDuckGoHtmlProvider({ fetchImpl });

    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toThrow(/bot challenge/);
  });

  it('serializes parallel searches with a minimum interval to avoid burst detection', async () => {
    const timestamps: number[] = [];
    const fetchImpl = vi.fn().mockImplementation(async () => {
      timestamps.push(Date.now());
      return htmlResponse(DDG_FIXTURE);
    });
    const provider = new DuckDuckGoHtmlProvider({ fetchImpl, minIntervalMs: 60 });

    await Promise.all([
      provider.search('milch', { site: 'migros.ch' }),
      provider.search('milch', { site: 'coop.ch' }),
    ]);

    expect(timestamps).toHaveLength(2);
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(50);
  });
});

describe('DuckDuckGoLiteProvider', () => {
  it('fetches and parses site-restricted results from lite.duckduckgo.com', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse(DDG_LITE_FIXTURE));
    const provider = new DuckDuckGoLiteProvider({ fetchImpl });

    const results = await provider.search('toothpaste sensitive', { site: 'migros.ch/de/product' });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const requestedUrl = fetchImpl.mock.calls[0][0] as string;
    expect(requestedUrl).toContain('lite.duckduckgo.com');
    expect(requestedUrl).toContain(encodeURIComponent('site:migros.ch/de/product toothpaste sensitive'));
    expect(results).toHaveLength(2);
  });

  it('throws on the HTTP 202 bot challenge instead of returning zero results', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse('challenge', 202));
    const provider = new DuckDuckGoLiteProvider({ fetchImpl });

    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toThrow(/bot challenge/);
  });

  it('has its own throttle independent from DuckDuckGoHtmlProvider', async () => {
    const timestamps: number[] = [];
    const fetchImpl = vi.fn().mockImplementation(async () => {
      timestamps.push(Date.now());
      return htmlResponse(DDG_LITE_FIXTURE);
    });
    const provider = new DuckDuckGoLiteProvider({ fetchImpl, minIntervalMs: 60 });

    await Promise.all([
      provider.search('milch', { site: 'migros.ch' }),
      provider.search('milch', { site: 'coop.ch' }),
    ]);

    expect(timestamps).toHaveLength(2);
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(50);
  });
});

describe('GoogleCustomSearchProvider', () => {
  it('queries the Custom Search API with a site restriction and filters foreign hosts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [
          { link: 'https://www.migros.ch/de/product/514160800000', title: 'Candida' },
          { link: 'https://www.example.com/unrelated', title: 'Foreign' },
          { link: 'https://www.migros.ch/de/product/514160800000', title: 'Duplicate' },
          { link: 'https://www.migros.ch/de/product/mo/106497', title: 'Online' },
        ],
      })
    );
    const provider = new GoogleCustomSearchProvider({ apiKey: 'key', cx: 'cx', fetchImpl });

    const results = await provider.search('toothpaste sensitive', { site: 'migros.ch/de/product' });

    const requestedUrl = fetchImpl.mock.calls[0][0] as string;
    expect(requestedUrl).toContain('customsearch/v1');
    expect(requestedUrl).toContain(encodeURIComponent('site:migros.ch/de/product toothpaste sensitive'));
    expect(results.map((r) => r.url)).toEqual([
      'https://www.migros.ch/de/product/514160800000',
      'https://www.migros.ch/de/product/mo/106497',
    ]);
  });

  it('throws on non-200 responses without leaking the request URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: {} }, 429));
    const provider = new GoogleCustomSearchProvider({ apiKey: 'secret-key', cx: 'cx', fetchImpl });

    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toThrow(
      /rate-limited.*429(?!.*secret-key)/
    );
  });
});

describe('createWebSearchProviderFromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns undefined when disabled', () => {
    expect(createWebSearchProviderFromEnv({ SWISS_SHOPPING_WEB_SEARCH: 'off' } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('returns undefined for mode=google without keys', () => {
    expect(createWebSearchProviderFromEnv({ SWISS_SHOPPING_WEB_SEARCH: 'google' } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('returns Google provider for mode=google with keys', () => {
    const provider = createWebSearchProviderFromEnv({
      SWISS_SHOPPING_WEB_SEARCH: 'google',
      GOOGLE_CSE_API_KEY: 'k',
      GOOGLE_CSE_CX: 'c',
    } as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(GoogleCustomSearchProvider);
  });

  it('auto mode always builds a DDG-based composite, with or without legacy Google keys', () => {
    const withKeys = createWebSearchProviderFromEnv({
      GOOGLE_CSE_API_KEY: 'k',
      GOOGLE_CSE_CX: 'c',
    } as NodeJS.ProcessEnv);
    expect(withKeys).toBeInstanceOf(CompositeWebSearchProvider);

    // Without any keys, auto mode still returns a composite (DDG html + DDG lite)
    const withoutKeys = createWebSearchProviderFromEnv({} as NodeJS.ProcessEnv);
    expect(withoutKeys).toBeInstanceOf(CompositeWebSearchProvider);
  });

  it('auto mode puts DDG (html then lite) first and never includes paid providers, even when keys are present', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse(DDG_FIXTURE));
    const provider = createWebSearchProviderFromEnv({
      SERP_API_KEY: 'sk',
      HASDATA_API_KEY: 'hk',
      SEARLO_API_KEY: 'sek',
      FIRECRAWL_API_KEY: 'fk',
    } as NodeJS.ProcessEnv, fetchImpl) as CompositeWebSearchProvider;

    await provider.search('milch', { site: 'migros.ch/de/product' });

    // Only DDG endpoints should ever be hit — html.duckduckgo.com first.
    const requestedUrl = fetchImpl.mock.calls[0][0] as string;
    expect(requestedUrl).toContain('html.duckduckgo.com');
    expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes('serpapi.com'))).toBe(false);
    expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes('hasdata.com'))).toBe(false);
    expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes('searlo.tech'))).toBe(false);
    expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes('firecrawl.dev'))).toBe(false);
  });

  it('auto mode falls back from DDG html to DDG lite on a retryable failure', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(htmlResponse('challenge', 202))
      .mockResolvedValueOnce(htmlResponse(DDG_LITE_FIXTURE));
    const provider = createWebSearchProviderFromEnv({} as NodeJS.ProcessEnv, fetchImpl) as CompositeWebSearchProvider;

    const results = await provider.search('milch', { site: 'migros.ch/de/product' });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('html.duckduckgo.com');
    expect(String(fetchImpl.mock.calls[1][0])).toContain('lite.duckduckgo.com');
    expect(results.length).toBeGreaterThan(0);
  });

  it('resolves unknown mode values to auto', () => {
    expect(resolveWebSearchMode({ SWISS_SHOPPING_WEB_SEARCH: 'banana' } as NodeJS.ProcessEnv)).toBe('auto');
    expect(resolveWebSearchMode({} as NodeJS.ProcessEnv)).toBe('auto');
  });

  it('returns SerpApiProvider for mode=serpapi with key', () => {
    const provider = createWebSearchProviderFromEnv({
      SWISS_SHOPPING_WEB_SEARCH: 'serpapi',
      SERP_API_KEY: 'key',
    } as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(SerpApiProvider);
  });

  it('returns undefined for mode=serpapi without key', () => {
    expect(createWebSearchProviderFromEnv({ SWISS_SHOPPING_WEB_SEARCH: 'serpapi' } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('returns HasDataProvider for mode=hasdata with key', () => {
    const provider = createWebSearchProviderFromEnv({
      SWISS_SHOPPING_WEB_SEARCH: 'hasdata',
      HASDATA_API_KEY: 'key',
    } as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(HasDataProvider);
  });

  it('returns undefined for mode=hasdata without key', () => {
    expect(createWebSearchProviderFromEnv({ SWISS_SHOPPING_WEB_SEARCH: 'hasdata' } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('returns SearloProvider for mode=searlo with key', () => {
    const provider = createWebSearchProviderFromEnv({
      SWISS_SHOPPING_WEB_SEARCH: 'searlo',
      SEARLO_API_KEY: 'key',
    } as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(SearloProvider);
  });

  it('returns undefined for mode=searlo without key', () => {
    expect(createWebSearchProviderFromEnv({ SWISS_SHOPPING_WEB_SEARCH: 'searlo' } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('returns FirecrawlSearchProvider for mode=firecrawl with key', () => {
    const provider = createWebSearchProviderFromEnv({
      SWISS_SHOPPING_WEB_SEARCH: 'firecrawl',
      FIRECRAWL_API_KEY: 'key',
    } as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(FirecrawlSearchProvider);
  });

  it('returns undefined for mode=firecrawl without key', () => {
    expect(createWebSearchProviderFromEnv({ SWISS_SHOPPING_WEB_SEARCH: 'firecrawl' } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('returns DuckDuckGoLiteProvider for mode=ddg-lite (always available, no key needed)', () => {
    const provider = createWebSearchProviderFromEnv({ SWISS_SHOPPING_WEB_SEARCH: 'ddg-lite' } as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(DuckDuckGoLiteProvider);
  });
});

// ---------------------------------------------------------------------------
// SerpApiProvider tests
// ---------------------------------------------------------------------------

describe('SerpApiProvider', () => {
  it('parses happy-path organic results and filters by site', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        organic_results: [
          { link: 'https://www.migros.ch/de/product/514160800000', title: 'Milk' },
          { link: 'https://www.example.com/other', title: 'Other' },
          { link: 'https://www.migros.ch/de/product/mo/106497', title: 'Online' },
        ],
        search_information: { total_results: 2 },
      })
    );
    const provider = new SerpApiProvider({ apiKey: 'key', fetchImpl });
    const results = await provider.search('milch', { site: 'migros.ch/de/product' });

    expect(results.map((r) => r.url)).toEqual([
      'https://www.migros.ch/de/product/514160800000',
      'https://www.migros.ch/de/product/mo/106497',
    ]);
    const requestedUrl = fetchImpl.mock.calls[0][0] as string;
    expect(requestedUrl).toContain('serpapi.com/search');
    expect(requestedUrl).toContain('engine=google');
  });

  it('throws non-retryable on 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, 401));
    const provider = new SerpApiProvider({ apiKey: 'bad', fetchImpl });
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: false,
      httpStatus: 401,
    });
  });

  it('throws non-retryable on 403', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'Forbidden' }, 403));
    const provider = new SerpApiProvider({ apiKey: 'bad', fetchImpl });
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: false,
      httpStatus: 403,
    });
  });

  it('throws retryable on 429', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'Rate limited' }, 429));
    const provider = new SerpApiProvider({ apiKey: 'key', fetchImpl });
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: true,
      httpStatus: 429,
    });
  });

  it('throws retryable on 500', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'Server error' }, 500));
    const provider = new SerpApiProvider({ apiKey: 'key', fetchImpl });
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: true,
      httpStatus: 500,
    });
  });

  it('throws non-retryable on malformed (non-JSON) response body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    const provider = new SerpApiProvider({ apiKey: 'key', fetchImpl });
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('returns empty array on 200 with no-results error (not a throw)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: "Google hasn't returned any results for this query." })
    );
    const provider = new SerpApiProvider({ apiKey: 'key', fetchImpl });
    const results = await provider.search('zzzznonexistent12345', { site: 'migros.ch' });
    expect(results).toEqual([]);
  });

  it('throws retryable error on "run out of searches"', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'You have run out of searches.' })
    );
    const provider = new SerpApiProvider({ apiKey: 'key', fetchImpl });
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('filters results across multiple sites in aggregated mode', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        organic_results: [
          { link: 'https://www.migros.ch/de/product/1', title: 'Milk' },
          { link: 'https://www.coop.ch/p/2', title: 'Bread' },
          { link: 'https://www.example.com/other', title: 'Foreign' },
          { link: 'https://www.migros.ch/de/product/3', title: 'Cheese' },
        ],
      })
    );
    const provider = new SerpApiProvider({ apiKey: 'key', fetchImpl });
    const results = await provider.search('food', { site: 'migros.ch OR site:coop.ch', sites: ['migros.ch', 'coop.ch'] });

    expect(results.map((r) => r.url)).toEqual([
      'https://www.migros.ch/de/product/1',
      'https://www.coop.ch/p/2',
      'https://www.migros.ch/de/product/3',
    ]);
  });

  it('retries once with the spelling-fix query when the original query returns nothing', async () => {
    // Real SerpAPI shape (verified live): spelling_fix echoes back the FULL
    // "site:<site> <query>" string we sent, not just the corrected term.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          organic_results: [],
          search_information: {
            organic_results_state: 'Empty showing fixed spelling results',
            spelling_fix: 'site:migros.ch/de/product heissleim',
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          organic_results: [{ link: 'https://www.migros.ch/de/product/heissleim-1', title: 'Heissleim' }],
        })
      );
    const provider = new SerpApiProvider({ apiKey: 'key', fetchImpl });
    const results = await provider.search('heisleim', { site: 'migros.ch/de/product' });

    expect(results.map((r) => r.url)).toEqual(['https://www.migros.ch/de/product/heissleim-1']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondUrl = fetchImpl.mock.calls[1][0] as string;
    // The site prefix must not be duplicated in the retried query.
    expect(decodeURIComponent(secondUrl)).toContain('q=site:migros.ch/de/product heissleim');
    expect(decodeURIComponent(secondUrl)).not.toContain('site:migros.ch/de/product site:migros.ch/de/product');
  });

  it('does not retry when no spelling fix is offered and results are genuinely empty', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ organic_results: [], search_information: { organic_results_state: 'Fully empty' } })
    );
    const provider = new SerpApiProvider({ apiKey: 'key', fetchImpl });
    const results = await provider.search('zzzznonexistent12345', { site: 'migros.ch' });

    expect(results).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// HasDataProvider tests
// ---------------------------------------------------------------------------

describe('HasDataProvider', () => {
  it('parses happy-path organicResults (camelCase) and filters by site', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        organicResults: [
          { link: 'https://www.migros.ch/de/product/514160800000', title: 'Milk' },
          { link: 'https://www.coop.ch/p/123', title: 'Wrong site' },
        ],
        searchInformation: { totalResults: 1 },
      })
    );
    const provider = new HasDataProvider({ apiKey: 'key', fetchImpl });
    const results = await provider.search('milch', { site: 'migros.ch/de/product' });

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://www.migros.ch/de/product/514160800000');
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ 'x-api-key': 'key' });
  });

  it('throws non-retryable on 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, 401));
    const provider = new HasDataProvider({ apiKey: 'bad', fetchImpl });
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: false,
      httpStatus: 401,
    });
  });

  it('throws retryable on 429', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'Rate limited' }, 429));
    const provider = new HasDataProvider({ apiKey: 'key', fetchImpl });
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: true,
      httpStatus: 429,
    });
  });

  it('throws retryable on 500', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'Server error' }, 500));
    const provider = new HasDataProvider({ apiKey: 'key', fetchImpl });
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: true,
      httpStatus: 500,
    });
  });

  it('throws non-retryable on malformed response body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>error</html>', { status: 200 }));
    const provider = new HasDataProvider({ apiKey: 'key', fetchImpl });
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('filters results across multiple sites in aggregated mode', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        organicResults: [
          { link: 'https://www.migros.ch/de/product/1', title: 'Milk' },
          { link: 'https://www.coop.ch/p/2', title: 'Bread' },
          { link: 'https://www.example.com/other', title: 'Foreign' },
        ],
      })
    );
    const provider = new HasDataProvider({ apiKey: 'key', fetchImpl });
    const results = await provider.search('food', { site: 'migros.ch OR site:coop.ch', sites: ['migros.ch', 'coop.ch'] });

    expect(results.map((r) => r.url)).toEqual([
      'https://www.migros.ch/de/product/1',
      'https://www.coop.ch/p/2',
    ]);
  });
});

// ---------------------------------------------------------------------------
// SearloProvider tests
// ---------------------------------------------------------------------------

describe('SearloProvider', () => {
  it('parses happy-path organic results (real shape with position) and filters by site', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        searchParameters: { q: 'site:migros.ch milch' },
        page: 1,
        totalResults: 42,
        organic: [
          { position: 1, title: 'Milk', link: 'https://www.migros.ch/de/product/514160800000', snippet: 'Fresh milk' },
          { position: 2, title: 'Other', link: 'https://www.example.com/other', snippet: '' },
          { position: 3, title: 'Online', link: 'https://www.migros.ch/de/product/mo/106497', snippet: '' },
        ],
      })
    );
    const provider = new SearloProvider({ apiKey: 'key', fetchImpl });
    const results = await provider.search('milch', { site: 'migros.ch/de/product' });

    expect(results.map((r) => r.url)).toEqual([
      'https://www.migros.ch/de/product/514160800000',
      'https://www.migros.ch/de/product/mo/106497',
    ]);
    const requestedUrl = fetchImpl.mock.calls[0][0] as string;
    expect(requestedUrl).toContain('api.searlo.tech/api/v1/search/web');
  });

  it('throws non-retryable on 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, 401));
    const provider = new SearloProvider({ apiKey: 'bad', fetchImpl });
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: false,
      httpStatus: 401,
    });
  });

  it('throws retryable on 429', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'Rate limited' }, 429));
    const provider = new SearloProvider({ apiKey: 'key', fetchImpl });
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: true,
      httpStatus: 429,
    });
  });

  it('throws retryable on 500', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'Server error' }, 500));
    const provider = new SearloProvider({ apiKey: 'key', fetchImpl });
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: true,
      httpStatus: 500,
    });
  });

  it('throws non-retryable on malformed response body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    const provider = new SearloProvider({ apiKey: 'key', fetchImpl });
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('filters results across multiple sites in aggregated mode', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        organic: [
          { position: 1, title: 'Milk', link: 'https://www.migros.ch/de/product/1' },
          { position: 2, title: 'Bread', link: 'https://www.coop.ch/p/2' },
          { position: 3, title: 'Foreign', link: 'https://www.example.com/other' },
        ],
      })
    );
    const provider = new SearloProvider({ apiKey: 'key', fetchImpl });
    const results = await provider.search('food', { site: 'migros.ch OR site:coop.ch', sites: ['migros.ch', 'coop.ch'] });

    expect(results.map((r) => r.url)).toEqual([
      'https://www.migros.ch/de/product/1',
      'https://www.coop.ch/p/2',
    ]);
  });
});

// ---------------------------------------------------------------------------
// FirecrawlSearchProvider tests
// ---------------------------------------------------------------------------

describe('FirecrawlSearchProvider', () => {
  it('parses happy-path data.web results (POST, Bearer auth) and filters by site', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          web: [
            { url: 'https://www.migros.ch/de/product/514160800000', title: 'Milk', description: 'Fresh' },
            { url: 'https://www.example.com/other', title: 'Other', description: '' },
            { url: 'https://www.migros.ch/de/product/mo/106497', title: 'Online', description: '' },
          ],
        },
      })
    );
    const provider = new FirecrawlSearchProvider({ apiKey: 'key', fetchImpl });
    const results = await provider.search('milch', { site: 'migros.ch/de/product' });

    expect(results.map((r) => r.url)).toEqual([
      'https://www.migros.ch/de/product/514160800000',
      'https://www.migros.ch/de/product/mo/106497',
    ]);
    // Verify POST method and Bearer auth
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer key' });
    // Verify body contains query
    const body = JSON.parse(init.body as string);
    expect(body.query).toContain('site:migros.ch');
  });

  it('throws non-retryable on 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, 401));
    const provider = new FirecrawlSearchProvider({ apiKey: 'bad', fetchImpl });
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: false,
      httpStatus: 401,
    });
  });

  it('throws retryable on 429', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'Rate limited' }, 429));
    const provider = new FirecrawlSearchProvider({ apiKey: 'key', fetchImpl });
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: true,
      httpStatus: 429,
    });
  });

  it('throws retryable on 500', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'Server error' }, 500));
    const provider = new FirecrawlSearchProvider({ apiKey: 'key', fetchImpl });
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: true,
      httpStatus: 500,
    });
  });

  it('throws non-retryable on malformed response body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    const provider = new FirecrawlSearchProvider({ apiKey: 'key', fetchImpl });
    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('filters results across multiple sites in aggregated mode', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          web: [
            { url: 'https://www.migros.ch/de/product/1', title: 'Milk' },
            { url: 'https://www.coop.ch/p/2', title: 'Bread' },
            { url: 'https://www.example.com/other', title: 'Foreign' },
          ],
        },
      })
    );
    const provider = new FirecrawlSearchProvider({ apiKey: 'key', fetchImpl });
    const results = await provider.search('food', { site: 'migros.ch OR site:coop.ch', sites: ['migros.ch', 'coop.ch'] });

    expect(results.map((r) => r.url)).toEqual([
      'https://www.migros.ch/de/product/1',
      'https://www.coop.ch/p/2',
    ]);
  });
});

// ---------------------------------------------------------------------------
// CompositeWebSearchProvider chain fallback tests
// ---------------------------------------------------------------------------

describe('CompositeWebSearchProvider chain fallback', () => {
  it('serpapi 429 falls to hasdata within same request', async () => {
    const serpapi = mockProviderEntry('serpapi', [], {
      failWith: new TypedWebSearchError({ message: '429', provider: 'serpapi', retryable: true, httpStatus: 429 }),
    });
    const hasdata = mockProviderEntry('hasdata', [{ url: 'https://migros.ch/product/1', rank: 0 }]);

    const provider = new CompositeWebSearchProvider({
      chain: [serpapi, hasdata],
    });
    const results = await provider.search('milch', { site: 'migros.ch' });

    expect(serpapi.provider.search).toHaveBeenCalledOnce();
    expect(hasdata.provider.search).toHaveBeenCalledOnce();
    expect(results).toEqual([{ url: 'https://migros.ch/product/1', rank: 0 }]);
  });

  it('serpapi 401 surfaces error (no fallback)', async () => {
    const serpapi = mockProviderEntry('serpapi', [], {
      failWith: new TypedWebSearchError({ message: '401', provider: 'serpapi', retryable: false, httpStatus: 401 }),
    });
    const hasdata = mockProviderEntry('hasdata', [{ url: 'https://migros.ch/product/1', rank: 0 }]);

    const provider = new CompositeWebSearchProvider({
      chain: [serpapi, hasdata],
    });

    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toMatchObject({
      retryable: false,
      httpStatus: 401,
    });
    expect(hasdata.provider.search).not.toHaveBeenCalled();
  });

  it('budget-exhausted provider is skipped without error', async () => {
    const serpapi = mockProviderEntry('serpapi', [{ url: 'https://migros.ch/product/1', rank: 0 }]);
    const hasdata = mockProviderEntry('hasdata', [{ url: 'https://migros.ch/product/2', rank: 0 }]);
    const budget = {
      isExhausted: vi.fn((p: string) => p === 'serpapi'),
      isLow: vi.fn(() => false),
      recordRequest: vi.fn(),
      recordFailure: vi.fn(),
      recordCacheHit: vi.fn(),
    };

    const provider = new CompositeWebSearchProvider({
      chain: [
        { ...serpapi, budget: budget as never },
        hasdata,
      ],
    });
    const results = await provider.search('milch', { site: 'migros.ch' });

    expect(serpapi.provider.search).not.toHaveBeenCalled();
    expect(hasdata.provider.search).toHaveBeenCalledOnce();
    expect(results).toEqual([{ url: 'https://migros.ch/product/2', rank: 0 }]);
  });
});

describe('CompositeWebSearchProvider short-TTL query cache', () => {
  it('is disabled by default — repeat identical queries still re-hit the chain', async () => {
    const serpapi = mockProviderEntry('serpapi', [{ url: 'https://migros.ch/product/1', rank: 0 }]);
    const provider = new CompositeWebSearchProvider({ chain: [serpapi] });

    await provider.search('milch', { site: 'migros.ch' });
    await provider.search('milch', { site: 'migros.ch' });

    expect(serpapi.provider.search).toHaveBeenCalledTimes(2);
  });

  it('when enabled, serves an identical repeat query from cache without re-hitting the chain', async () => {
    const serpapi = mockProviderEntry('serpapi', [{ url: 'https://migros.ch/product/1', rank: 0 }]);
    const provider = new CompositeWebSearchProvider({ chain: [serpapi], cacheTtlMs: 60_000 });

    const first = await provider.search('milch', { site: 'migros.ch' });
    const second = await provider.search('milch', { site: 'migros.ch' });

    expect(serpapi.provider.search).toHaveBeenCalledOnce();
    expect(second).toEqual(first);
  });

  it('is case/whitespace-insensitive on the query but distinguishes different sites', async () => {
    const serpapi = mockProviderEntry('serpapi', [{ url: 'https://migros.ch/product/1', rank: 0 }]);
    const provider = new CompositeWebSearchProvider({ chain: [serpapi], cacheTtlMs: 60_000 });

    await provider.search('  Milch ', { site: 'migros.ch' });
    await provider.search('milch', { site: 'migros.ch' });
    expect(serpapi.provider.search).toHaveBeenCalledOnce();

    await provider.search('milch', { site: 'coop.ch' });
    expect(serpapi.provider.search).toHaveBeenCalledTimes(2);
  });

  it('re-queries once the cache TTL expires', async () => {
    let now = 0;
    const clock = { now: (): Date => new Date(now) };
    const serpapi = mockProviderEntry('serpapi', [{ url: 'https://migros.ch/product/1', rank: 0 }]);
    const provider = new CompositeWebSearchProvider({ chain: [serpapi], clock, cacheTtlMs: 1_000 });

    await provider.search('milch', { site: 'migros.ch' });
    now += 1_001;
    await provider.search('milch', { site: 'migros.ch' });

    expect(serpapi.provider.search).toHaveBeenCalledTimes(2);
  });

  it('caches aggregated multi-site searches too, when enabled', async () => {
    const serpapi = mockProviderEntry('serpapi', [{ url: 'https://migros.ch/product/1', rank: 0 }]);
    const provider = new CompositeWebSearchProvider({ chain: [serpapi], cacheTtlMs: 60_000 });

    await provider.searchAggregated('milch', ['migros.ch', 'coop.ch']);
    await provider.searchAggregated('milch', ['coop.ch', 'migros.ch']);

    expect(serpapi.provider.search).toHaveBeenCalledOnce();
  });

  it('buildAutoComposite (the real "auto" default chain) enables the cache by default', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse(DDG_FIXTURE));
    const provider = createWebSearchProviderFromEnv({} as NodeJS.ProcessEnv, fetchImpl) as CompositeWebSearchProvider;

    await provider.search('milch', { site: 'migros.ch/de/product' });
    await provider.search('milch', { site: 'migros.ch/de/product' });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('CompositeWebSearchProvider metrics wiring', () => {
  function mockMetrics(): {
    recordProviderRequest: ReturnType<typeof vi.fn>;
    recordProviderFallbackFrom: ReturnType<typeof vi.fn>;
    recordCircuitBreakerOpen: ReturnType<typeof vi.fn>;
  } {
    return {
      recordProviderRequest: vi.fn(),
      recordProviderFallbackFrom: vi.fn(),
      recordCircuitBreakerOpen: vi.fn(),
    };
  }

  it('calls recordProviderRequest before each provider attempt', async () => {
    const metrics = mockMetrics();
    const serpapi = mockProviderEntry('serpapi', [{ url: 'https://migros.ch/1', rank: 0 }]);
    const provider = new CompositeWebSearchProvider({
      chain: [{ ...serpapi }],
      metrics: metrics as never,
    });

    await provider.search('milch', { site: 'migros.ch' });

    expect(metrics.recordProviderRequest).toHaveBeenCalledWith('serpapi');
  });

  it('calls recordProviderFallbackFrom on retryable failure then success', async () => {
    const metrics = mockMetrics();
    const serpapi = mockProviderEntry('serpapi', [], {
      failWith: new TypedWebSearchError({ message: 'rate limited', provider: 'serpapi', retryable: true }),
    });
    const hasdata = mockProviderEntry('hasdata', [{ url: 'https://migros.ch/1', rank: 0 }]);

    const provider = new CompositeWebSearchProvider({
      chain: [{ ...serpapi }, hasdata],
      metrics: metrics as never,
    });

    const results = await provider.search('milch', { site: 'migros.ch' });

    expect(metrics.recordProviderRequest).toHaveBeenCalledWith('serpapi');
    expect(metrics.recordProviderRequest).toHaveBeenCalledWith('hasdata');
    expect(metrics.recordProviderFallbackFrom).toHaveBeenCalledWith('serpapi');
    expect(results).toEqual([{ url: 'https://migros.ch/1', rank: 0 }]);
  });

  it('does not call recordProviderFallbackFrom on non-retryable error', async () => {
    const metrics = mockMetrics();
    const serpapi = mockProviderEntry('serpapi', [], {
      failWith: new TypedWebSearchError({ message: 'invalid key', provider: 'serpapi', retryable: false }),
    });

    const provider = new CompositeWebSearchProvider({
      chain: [{ ...serpapi }],
      metrics: metrics as never,
    });

    await expect(provider.search('milch', { site: 'migros.ch' })).rejects.toThrow('invalid key');

    expect(metrics.recordProviderRequest).toHaveBeenCalledWith('serpapi');
    expect(metrics.recordProviderFallbackFrom).not.toHaveBeenCalled();
  });

  it('calls recordCircuitBreakerOpen when breaker is open', async () => {
    const metrics = mockMetrics();
    const breaker = new SourceCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
    // Trip the breaker
    breaker.recordFailure('serpapi');

    const serpapi = mockProviderEntry('serpapi', [{ url: 'https://migros.ch/1', rank: 0 }]);

    const provider = new CompositeWebSearchProvider({
      chain: [{ ...serpapi, breaker }],
      metrics: metrics as never,
    });

    const results = await provider.search('milch', { site: 'migros.ch' });

    expect(metrics.recordCircuitBreakerOpen).toHaveBeenCalled();
    expect(metrics.recordProviderRequest).not.toHaveBeenCalled();
    expect(serpapi.provider.search).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('does not call recordProviderFallbackFrom when first provider succeeds', async () => {
    const metrics = mockMetrics();
    const serpapi = mockProviderEntry('serpapi', [{ url: 'https://migros.ch/1', rank: 0 }]);

    const provider = new CompositeWebSearchProvider({
      chain: [{ ...serpapi }],
      metrics: metrics as never,
    });

    await provider.search('milch', { site: 'migros.ch' });

    expect(metrics.recordProviderFallbackFrom).not.toHaveBeenCalled();
  });
});
