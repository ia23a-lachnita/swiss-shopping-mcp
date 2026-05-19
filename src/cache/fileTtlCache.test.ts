import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { FileTtlCache } from './fileTtlCache.js';

const cacheDirs: string[] = [];

interface TestCache {
  cache: FileTtlCache;
  directory: string;
}

function cacheFileName(key: string): string {
  return `${createHash('sha256').update(key).digest('hex')}.json`;
}

async function createCache(now: () => Date): Promise<TestCache> {
  const directory = await mkdtemp(join(tmpdir(), 'swiss-shopping-cache-'));
  cacheDirs.push(directory);
  return {
    cache: new FileTtlCache(directory, { now }),
    directory,
  };
}

describe('FileTtlCache', () => {
  afterEach(async () => {
    await Promise.all(cacheDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('stores cache records with provenance and returns fresh cached data', async () => {
    const now = new Date('2026-05-18T10:00:00.000Z');
    const { cache } = await createCache(() => now);

    await cache.set(
      'migros:milk',
      { products: [{ id: 'p1' }] },
      {
        provider: 'Migros',
        chain: 'migros',
        sourceType: 'retailer-web',
        sourceUrl: 'https://example.test/search?q=milk',
        confidence: 'medium',
      },
      60_000,
    );

    const hit = await cache.get<{ products: Array<{ id: string }> }>('migros:milk');

    expect(hit).toBeDefined();
    expect(hit?.data.products[0].id).toBe('p1');
    expect(hit?.isStale).toBe(false);
    expect(hit?.provenance).toMatchObject({
      provider: 'Migros',
      freshness: 'cached',
      observedAt: '2026-05-18T10:00:00.000Z',
      cacheExpiresAt: '2026-05-18T10:01:00.000Z',
    });
  });

  it('expires records unless stale reads are explicitly allowed', async () => {
    let now = new Date('2026-05-18T10:00:00.000Z');
    const { cache } = await createCache(() => now);

    await cache.set(
      'coop:bread',
      { value: 1 },
      {
        provider: 'Coop',
        chain: 'coop',
        sourceType: 'retailer-web',
        confidence: 'medium',
      },
      1_000,
    );

    now = new Date('2026-05-18T10:00:02.000Z');

    const staleHit = await cache.get<{ value: number }>('coop:bread', { allowStale: true });
    expect(staleHit?.isStale).toBe(true);
    expect(staleHit?.provenance.freshness).toBe('stale');

    const normalHit = await cache.get<{ value: number }>('coop:bread');
    expect(normalHit).toBeUndefined();
  });

  it('rejects non-positive TTL values', async () => {
    const now = new Date('2026-05-18T10:00:00.000Z');
    const { cache } = await createCache(() => now);

    await expect(
      cache.set(
        'aldi:milk',
        { value: 1 },
        {
          provider: 'Aldi',
          chain: 'aldi',
          sourceType: 'retailer-web',
          confidence: 'medium',
        },
        0,
      ),
    ).rejects.toThrow('Cache TTL must be greater than zero.');
  });

  it('detects cache key mismatches instead of returning the wrong payload', async () => {
    const now = new Date('2026-05-18T10:00:00.000Z');
    const { cache, directory } = await createCache(() => now);
    const requestedKey = 'lidl:milk';
    const cachePath = join(directory, cacheFileName(requestedKey));

    await writeFile(
      cachePath,
      JSON.stringify({
        key: 'lidl:bread',
        data: { value: 1 },
        provenance: {
          provider: 'Lidl',
          chain: 'lidl',
          sourceType: 'retailer-web',
          observedAt: now.toISOString(),
          freshness: 'cached',
          confidence: 'medium',
        },
        observedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      }),
      'utf8',
    );

    await expect(cache.get(requestedKey)).rejects.toThrow('Cache key mismatch');
  });
});
