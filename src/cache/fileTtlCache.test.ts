import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { FileTtlCache } from './fileTtlCache.js';
import { DISCOVERY, NORMAL_PRICE } from './freshnessPolicy.js';

const cacheDirs: string[] = [];

interface TestCache {
  cache: FileTtlCache;
  directory: string;
}

function cacheFileName(key: string): string {
  return `${createHash('sha256').update(key).digest('hex')}.json`;
}

async function createCache(now: () => Date, maxFiles?: number): Promise<TestCache> {
  const directory = await mkdtemp(join(tmpdir(), 'swiss-shopping-cache-'));
  cacheDirs.push(directory);
  return {
    cache: new FileTtlCache(directory, { now }, maxFiles),
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
      NORMAL_PRICE,
    );

    const hit = await cache.get<{ products: Array<{ id: string }> }>('migros:milk');

    expect(hit).toBeDefined();
    expect(hit?.data.products[0].id).toBe('p1');
    expect(hit?.fresh).toBe(true);
    expect(hit?.needsRefresh).toBe(false);
    expect(hit?.staleFallback).toBeUndefined();
    expect(hit?.provenance).toMatchObject({
      provider: 'Migros',
      freshness: 'cached',
      observedAt: '2026-05-18T10:00:00.000Z',
    });
  });

  it('returns needsRefresh when soft TTL has passed but hard TTL has not', async () => {
    const now = new Date('2026-05-18T10:00:00.000Z');
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
      DISCOVERY,
    );

    // Advance past soft TTL (7 days) but within hard TTL (30 days)
    // Use a single cache with a mutable clock.
    let currentTime = now;
    const { cache: cache3 } = await createCache(() => currentTime);

    await cache3.set(
      'test:soft',
      { value: 42 },
      { provider: 'Test', chain: 'migros', sourceType: 'retailer-web', confidence: 'medium' },
      DISCOVERY,
    );

    // Advance past soft TTL (7 days = 604800000 ms)
    currentTime = new Date(now.getTime() + 604_800_000 + 1);
    const hit = await cache3.get<{ value: number }>('test:soft');

    expect(hit).toBeDefined();
    expect(hit?.fresh).toBe(false);
    expect(hit?.needsRefresh).toBe(true);
    expect(hit?.staleFallback).toBeUndefined();
  });

  it('returns staleFallback when past hard TTL but within stale window', async () => {
    let currentTime = new Date('2026-05-18T10:00:00.000Z');
    const { cache } = await createCache(() => currentTime);

    await cache.set(
      'test:stale',
      { value: 99 },
      { provider: 'Test', chain: 'migros', sourceType: 'retailer-web', confidence: 'medium' },
      DISCOVERY,
    );

    // Advance past hard TTL (30 days) but within stale window (90 days)
    currentTime = new Date(currentTime.getTime() + 30 * 24 * 60 * 60 * 1_000 + 1);
    const hit = await cache.get<{ value: number }>('test:stale', { allowStale: true });

    expect(hit).toBeDefined();
    expect(hit?.fresh).toBe(false);
    expect(hit?.needsRefresh).toBe(true);
    expect(hit?.staleFallback).toEqual({ value: 99 });
  });

  it('deletes record and returns undefined when past stale window', async () => {
    let currentTime = new Date('2026-05-18T10:00:00.000Z');
    const { cache } = await createCache(() => currentTime);

    await cache.set(
      'test:expired',
      { value: 1 },
      { provider: 'Test', chain: 'migros', sourceType: 'retailer-web', confidence: 'medium' },
      DISCOVERY,
    );

    // Advance past stale window (90 days)
    currentTime = new Date(currentTime.getTime() + 90 * 24 * 60 * 60 * 1_000 + 1);
    const hit = await cache.get<{ value: number }>('test:expired');

    expect(hit).toBeUndefined();
  });

  it('treats legacy records (no refreshAfter/staleUntil) as refreshAfter=expiresAt, staleUntil=expiresAt', async () => {
    const now = new Date('2026-05-18T10:00:00.000Z');
    const { cache, directory } = await createCache(() => now);
    const key = 'legacy:record';
    const cachePath = join(directory, cacheFileName(key));

    // Write a legacy-format record (no refreshAfter, no staleUntil)
    await writeFile(
      cachePath,
      JSON.stringify({
        key,
        data: { value: 42 },
        provenance: {
          provider: 'Test',
          chain: 'migros',
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

    // Not expired yet — should work like normal (fresh = true since refreshAfter=expiresAt and now < expiresAt)
    const freshHit = await cache.get<{ value: number }>(key);
    expect(freshHit?.fresh).toBe(true);

    // Past expiry — legacy record has staleUntil = expiresAt, so it's deleted
    const currentTime = new Date(now.getTime() + 61_000);
    const { cache: expiredCache, directory: expiredDir } = await createCache(() => currentTime);

    // Write the same legacy record to the new cache dir
    await writeFile(
      join(expiredDir, cacheFileName(key)),
      JSON.stringify({
        key,
        data: { value: 42 },
        provenance: {
          provider: 'Test',
          chain: 'migros',
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

    const expiredHit = await expiredCache.get<{ value: number }>(key);
    expect(expiredHit).toBeUndefined();
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

  it('prune() removes stale records past staleUntil', async () => {
    let currentTime = new Date('2026-05-18T10:00:00.000Z');
    const { cache } = await createCache(() => currentTime);

    // Write a record that will become stale
    await cache.set(
      'prune:stale',
      { value: 1 },
      { provider: 'Test', chain: 'migros', sourceType: 'retailer-web', confidence: 'medium' },
      DISCOVERY,
    );

    // Advance past stale window (90 days)
    currentTime = new Date(currentTime.getTime() + 91 * 24 * 60 * 60 * 1_000);
    const stats = await cache.prune();

    expect(stats.entryCount).toBe(0);
  });

  it('prune() evicts LRU files when over maxFiles', async () => {
    let currentTime = new Date('2026-05-18T10:00:00.000Z');
    const { cache } = await createCache(() => currentTime, 3);

    // Write 5 records with different mtimes
    for (let i = 0; i < 5; i++) {
      currentTime = new Date(currentTime.getTime() + 1000);
      await cache.set(
        `evict:${i}`,
        { value: i },
        { provider: 'Test', chain: 'migros', sourceType: 'retailer-web', confidence: 'medium' },
        DISCOVERY,
      );
    }

    const stats = await cache.prune();
    expect(stats.entryCount).toBeLessThanOrEqual(3);
  });

  it('prune() tolerates a file disappearing mid-prune', async () => {
    const currentTime = new Date('2026-05-18T10:00:00.000Z');
    const { cache, directory } = await createCache(() => currentTime);

    await cache.set(
      'resilient:key',
      { value: 1 },
      { provider: 'Test', chain: 'migros', sourceType: 'retailer-web', confidence: 'medium' },
      DISCOVERY,
    );

    // Delete the file before prune runs
    const { unlink } = await import('node:fs/promises');
    await unlink(join(directory, cacheFileName('resilient:key')));

    // Prune should not throw
    const stats = await cache.prune();
    expect(stats.entryCount).toBe(0);
  });

  it('stats() returns correct entry count and total bytes', async () => {
    const now = new Date('2026-05-18T10:00:00.000Z');
    const { cache } = await createCache(() => now);

    await cache.set(
      'stats:one',
      { value: 1 },
      { provider: 'Test', chain: 'migros', sourceType: 'retailer-web', confidence: 'medium' },
      NORMAL_PRICE,
    );
    await cache.set(
      'stats:two',
      { value: 2 },
      { provider: 'Test', chain: 'coop', sourceType: 'retailer-web', confidence: 'medium' },
      NORMAL_PRICE,
    );

    const stats = await cache.stats();
    expect(stats.entryCount).toBe(2);
    expect(stats.totalBytes).toBeGreaterThan(0);
  });
});
