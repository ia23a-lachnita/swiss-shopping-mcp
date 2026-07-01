import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { SourceHttpClient } from '../../sources/sourceClient.js';
import { SourceWarningCode } from '../types.js';
import { AldiLiveAdapter } from './aldiLiveAdapter.js';

const PRODUCT_URL = 'https://www.aldi-suisse.ch/de/produkt/backbox-toskanabrot-000000000000101698';
const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url>
    <loc>${PRODUCT_URL}</loc>
    <lastmod>2026-05-18</lastmod>
  </url>
</urlset>`;

const cacheDirectories: string[] = [];

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    statusText: status === 200 ? 'OK' : 'Failure',
    headers: { 'content-type': 'text/html' },
  });
}

async function createCache(clock?: { now(): Date }): Promise<FileTtlCache> {
  const directory = await mkdtemp(join(tmpdir(), 'swiss-shopping-mcp-aldi-test-'));
  cacheDirectories.push(directory);
  return new FileTtlCache(directory, clock);
}

async function readProductHtml(): Promise<string> {
  return readFile(new URL('../../../fixtures/live-sources/aldi/product-toskanabrot.sample.html', import.meta.url), 'utf8');
}

function createFetch(productHtml: string): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL | Request) => {
    const target = url.toString();
    if (target.endsWith('/sitemap_products.xml')) {
      return textResponse(SITEMAP_XML);
    }
    if (target === PRODUCT_URL) {
      return textResponse(productHtml);
    }
    return textResponse('not found', 404);
  });
}

describe('AldiLiveAdapter', () => {
  afterEach(async () => {
    await Promise.all(cacheDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('searches live Aldi sources and returns product provenance metadata', async () => {
    const productHtml = await readProductHtml();
    const fetchImpl = createFetch(productHtml) as unknown as typeof fetch;
    const adapter = new AldiLiveAdapter({
      cache: await createCache(),
      sourceClient: new SourceHttpClient({ fetchImpl, retries: 0, rateLimitPerHostMs: 0 }),
      cacheTtlMs: 60_000,
    });

    const result = await adapter.searchProducts({ query: 'toskanabrot' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      id: 'backbox-toskanabrot-000000000000101698',
      chain: 'aldi',
      name: 'Toskanabrot',
      provenance: {
        provider: 'ALDI SUISSE',
        chain: 'aldi',
        sourceType: 'retailer-web',
        sourceUrl: PRODUCT_URL,
        freshness: 'live',
      },
    });
    expect(result.metadata?.sources?.[0]).toMatchObject({
      chain: 'aldi',
      status: 'live-beta',
      provider: 'ALDI SUISSE',
    });
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
  });

  it('uses cached sitemap and product pages on repeated searches', async () => {
    const productHtml = await readProductHtml();
    const fetchImpl = createFetch(productHtml) as unknown as typeof fetch;
    const adapter = new AldiLiveAdapter({
      cache: await createCache(),
      sourceClient: new SourceHttpClient({ fetchImpl, retries: 0, rateLimitPerHostMs: 0 }),
      cacheTtlMs: 60_000,
    });

    await adapter.searchProducts({ query: 'toskanabrot' });
    vi.mocked(fetchImpl).mockClear();
    const result = await adapter.searchProducts({ query: 'toskanabrot' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].provenance?.freshness).toBe('cached');
    expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled();
  });

  it('uses stale cached products with explicit warnings when live refresh fails', async () => {
    let now = new Date('2026-05-18T10:00:00.000Z');
    const clock = { now: (): Date => now };
    const productHtml = await readProductHtml();
    const fetchImpl = createFetch(productHtml) as unknown as typeof fetch;
    const adapter = new AldiLiveAdapter({
      cache: await createCache(clock),
      sourceClient: new SourceHttpClient({ fetchImpl, retries: 0, rateLimitPerHostMs: 0 }),
      cacheTtlMs: 1,
    });

    await adapter.searchProducts({ query: 'toskanabrot' });
    now = new Date('2026-05-18T10:00:01.000Z');
    vi.mocked(fetchImpl).mockReset();
    vi.mocked(fetchImpl).mockResolvedValue(textResponse('unavailable', 503));

    const result = await adapter.searchProducts({ query: 'toskanabrot' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0].provenance?.freshness).toBe('stale');
    expect(result.metadata?.sourceWarnings?.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([SourceWarningCode.SourceUnavailable, SourceWarningCode.SourceStaleCacheUsed]),
    );
    expect(result.metadata?.sources?.[0]).toMatchObject({ chain: 'aldi', status: 'degraded' });
  });

  it('returns an explicit source error when no live source or cache is available', async () => {
    const fetchImpl = vi.fn(async () => textResponse('unavailable', 503)) as unknown as typeof fetch;
    const adapter = new AldiLiveAdapter({
      cache: await createCache(),
      sourceClient: new SourceHttpClient({ fetchImpl, retries: 0, rateLimitPerHostMs: 0 }),
    });

    const result = await adapter.searchProducts({ query: 'toskanabrot' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(SourceWarningCode.SourceUnavailable);
      expect(result.error.message).toContain('Aldi product sitemap fetch failed');
    }
  });

  it('getStoreAvailabilitySupport returns supported: true', () => {
    const adapter = new AldiLiveAdapter({
      cache: undefined as unknown as FileTtlCache,
      sourceClient: new SourceHttpClient({ fetchImpl: vi.fn() as unknown as typeof fetch, retries: 0 }),
    });
    const support = adapter.getStoreAvailabilitySupport();
    expect(support.chain).toBe('aldi');
    expect(support.supported).toBe(true);
    expect(support.reason).toBeTruthy();
  });

  it('findStores returns error when fetch fails', async () => {
    const adapter = new AldiLiveAdapter({
      cache: await createCache(),
      sourceClient: new SourceHttpClient({ fetchImpl: vi.fn() as unknown as typeof fetch, retries: 0 }),
    });
    const stores = await adapter.findStores({ location: 'Zürich', latitude: 47.3769, longitude: 8.5417 });
    expect(stores.ok).toBe(false);
  });
});
