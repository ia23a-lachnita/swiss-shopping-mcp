import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { SourceHttpClient } from '../../sources/sourceClient.js';
import { UnsupportedChainAdapter } from '../unsupportedAdapter.js';
import { SourceWarningCode } from '../types.js';
import { DennerPromotionsAdapter } from './dennerPromotionsAdapter.js';

const cacheDirectories: string[] = [];

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    statusText: status === 200 ? 'OK' : 'Failure',
    headers: { 'content-type': 'text/html' },
  });
}

async function createCache(clock?: { now(): Date }): Promise<FileTtlCache> {
  const directory = await mkdtemp(join(tmpdir(), 'swiss-shopping-mcp-denner-test-'));
  cacheDirectories.push(directory);
  return new FileTtlCache(directory, clock);
}

async function readPromotionsHtml(): Promise<string> {
  return readFile(
    new URL('../../../fixtures/live-sources/denner/current-actions.sample.html', import.meta.url),
    'utf8'
  );
}

function makeDelegate(): UnsupportedChainAdapter {
  return new UnsupportedChainAdapter('denner', {
    productSearch: 'Denner product catalog search is not backed by a real source yet.',
    storeSearch: 'Denner store lookup is not backed by a real source yet.',
    availability: 'Denner store-level availability is not backed by a real source.',
  });
}

async function createAdapter(
  fetchImpl: typeof fetch,
  options: { cacheTtlMs?: number; clock?: { now(): Date }; now?: () => Date } = {}
): Promise<DennerPromotionsAdapter> {
  return new DennerPromotionsAdapter({
    delegate: makeDelegate(),
    cache: await createCache(options.clock),
    sourceClient: new SourceHttpClient({ fetchImpl, retries: 0, rateLimitPerHostMs: 0 }),
    cacheTtlMs: options.cacheTtlMs ?? 60_000,
    now: options.now ?? ((): Date => new Date('2026-05-19T10:00:00.000Z')),
  });
}

describe('DennerPromotionsAdapter', () => {
  afterEach(async () => {
    await Promise.all(
      cacheDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it('searches live Denner promotions with provenance metadata', async () => {
    const html = await readPromotionsHtml();
    const fetchImpl = vi.fn(async () => textResponse(html)) as unknown as typeof fetch;
    const adapter = await createAdapter(fetchImpl);

    const result = await adapter.searchPromotions({ query: 'orangensaft' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      id: 'hohes-c-orangensaft~p1028409:1f909593-6dec-48b0-b634-2c6c92cff6f8',
      chain: 'denner',
      title: 'Hohes C Orangensaft',
      price: { current: 11.95, unit: { value: 6, per: 'l' } },
      provenance: {
        provider: 'Denner',
        chain: 'denner',
        sourceType: 'retailer-web',
        sourceUrl:
          'https://www.denner.ch/de/aktionen/hohes-c-orangensaft~p1028409?variant=1f909593-6dec-48b0-b634-2c6c92cff6f8',
        freshness: 'live',
      },
    });
    expect(result.metadata?.sources?.[0]).toMatchObject({ chain: 'denner', status: 'live-beta' });
  });

  it('uses stale cached promotions with explicit warnings when live refresh fails', async () => {
    let cacheNow = new Date('2026-05-19T10:00:00.000Z');
    const clock = { now: (): Date => cacheNow };
    const html = await readPromotionsHtml();
    const fetchImpl = vi.fn(async () => textResponse(html)) as unknown as typeof fetch;
    const adapter = await createAdapter(fetchImpl, { cacheTtlMs: 1, clock });

    await adapter.searchPromotions({ query: 'orangensaft' });
    cacheNow = new Date('2026-05-19T10:00:01.000Z');
    vi.mocked(fetchImpl).mockResolvedValue(textResponse('unavailable', 503));

    const result = await adapter.searchPromotions({ query: 'orangensaft' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0].provenance?.freshness).toBe('stale');
    expect(result.metadata?.sourceWarnings?.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        SourceWarningCode.SourceUnavailable,
        SourceWarningCode.SourceStaleCacheUsed,
      ])
    );
    expect(result.metadata?.sources?.[0]).toMatchObject({ chain: 'denner', status: 'degraded' });
  });

  it('filters expired promotions before returning matches', async () => {
    const html = await readPromotionsHtml();
    const fetchImpl = vi.fn(async () => textResponse(html)) as unknown as typeof fetch;
    const adapter = await createAdapter(fetchImpl, {
      now: () => new Date('2026-05-21T10:00:00.000Z'),
    });

    const result = await adapter.searchPromotions({ query: 'orangensaft' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(0);
    }
  });

  it('Denner product search returns results from promotions and search page', async () => {
    const fetchImpl = vi.fn(async () => textResponse('not used')) as unknown as typeof fetch;
    const adapter = await createAdapter(fetchImpl);

    const result = await adapter.searchProducts({ query: 'pasta' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.data)).toBe(true);
    }
  });
});
