import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  CompositeWebSearchProvider,
  createWebSearchProviderFromEnv,
  DuckDuckGoHtmlProvider,
  GoogleCustomSearchProvider,
  parseDuckDuckGoHtml,
  resolveDuckDuckGoHref,
  resolveWebSearchMode,
  siteHost,
} from './webSearch.js';

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

  it('auto mode prefers Google when keys are present, otherwise DuckDuckGo', () => {
    const withKeys = createWebSearchProviderFromEnv({
      GOOGLE_CSE_API_KEY: 'k',
      GOOGLE_CSE_CX: 'c',
    } as NodeJS.ProcessEnv);
    expect(withKeys).toBeInstanceOf(CompositeWebSearchProvider);

    const withoutKeys = createWebSearchProviderFromEnv({} as NodeJS.ProcessEnv);
    expect(withoutKeys).toBeInstanceOf(DuckDuckGoHtmlProvider);
  });

  it('resolves unknown mode values to auto', () => {
    expect(resolveWebSearchMode({ SWISS_SHOPPING_WEB_SEARCH: 'banana' } as NodeJS.ProcessEnv)).toBe('auto');
    expect(resolveWebSearchMode({} as NodeJS.ProcessEnv)).toBe('auto');
  });
});
