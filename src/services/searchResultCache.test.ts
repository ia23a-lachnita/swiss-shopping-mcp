import { describe, it, expect, vi } from 'vitest';

import { SearchResultCache } from './searchResultCache.js';
import { NormalizedProduct } from '../adapters/types.js';

function product(id: string): NormalizedProduct {
  return { id, chain: 'coop', name: id, price: { current: 1 } } as NormalizedProduct;
}

function fakeClock(start = 0): { now(): number; advance(ms: number): void } {
  let t = start;
  return {
    now: (): number => t,
    advance: (ms: number): void => {
      t += ms;
    },
  };
}

describe('SearchResultCache.keyFor', () => {
  it('normalises query case and whitespace', () => {
    expect(SearchResultCache.keyFor({ query: '  Voll   Milch ' })).toBe(
      SearchResultCache.keyFor({ query: 'voll milch' })
    );
  });

  it('is order-independent across the chain list', () => {
    expect(SearchResultCache.keyFor({ query: 'milch', chains: ['migros', 'coop'] })).toBe(
      SearchResultCache.keyFor({ query: 'milch', chains: ['coop', 'migros'] })
    );
  });

  it('separates entries that differ in a filter', () => {
    const base = { query: 'milch', chains: ['coop'] };
    expect(SearchResultCache.keyFor(base)).not.toBe(
      SearchResultCache.keyFor({ ...base, limit: 12 })
    );
    expect(SearchResultCache.keyFor(base)).not.toBe(
      SearchResultCache.keyFor({ ...base, maxPrice: 5 })
    );
    expect(SearchResultCache.keyFor({ query: 'milch' })).not.toBe(
      SearchResultCache.keyFor({ query: 'milch', chains: ['coop'] })
    );
  });
});

describe('SearchResultCache', () => {
  it('misses on an unknown key', () => {
    expect(new SearchResultCache().get('nope').status).toBe('miss');
  });

  it('returns a fresh hit inside the fresh window', () => {
    const clock = fakeClock();
    const cache = new SearchResultCache({ freshMs: 1_000, staleMs: 10_000, clock });
    cache.set('k', { data: [product('a')] }, true);
    clock.advance(500);
    const hit = cache.get('k');
    expect(hit.status).toBe('fresh');
    if (hit.status !== 'miss') expect(hit.value.data).toHaveLength(1);
  });

  it('returns a stale hit between the fresh and stale windows', () => {
    const clock = fakeClock();
    const cache = new SearchResultCache({ freshMs: 1_000, staleMs: 10_000, clock });
    cache.set('k', { data: [product('a')] }, true);
    clock.advance(5_000);
    expect(cache.get('k').status).toBe('stale');
  });

  it('drops the entry once it is past the stale window', () => {
    const clock = fakeClock();
    const cache = new SearchResultCache({ freshMs: 1_000, staleMs: 10_000, clock });
    cache.set('k', { data: [product('a')] }, true);
    clock.advance(11_000);
    expect(cache.get('k').status).toBe('miss');
    expect(cache.size).toBe(0);
  });

  it('refuses to store a result the caller flags as incomplete', () => {
    const cache = new SearchResultCache();
    // Caching this would make one chain's blip stick to every later hit.
    expect(cache.set('k', { data: [product('a')] }, false)).toBe(false);
    expect(cache.get('k').status).toBe('miss');
  });

  it('stores a complete result even when it carries warnings', () => {
    // Warnings alone must not veto caching: the optional web-search step emits
    // them routinely, which previously stopped the cache ever populating.
    const cache = new SearchResultCache();
    expect(
      cache.set(
        'k',
        {
          data: [product('a')],
          metadata: {
            sourceWarnings: [{ provider: 'WebSearch', code: 'SOURCE_UNAVAILABLE', message: 'x' }],
          } as never,
        },
        true
      )
    ).toBe(true);
    expect(cache.get('k').status).toBe('fresh');
  });

  it('evicts the oldest entry past maxEntries', () => {
    const cache = new SearchResultCache({ maxEntries: 2 });
    cache.set('a', { data: [product('a')] }, true);
    cache.set('b', { data: [product('b')] }, true);
    cache.set('c', { data: [product('c')] }, true);
    expect(cache.size).toBe(2);
    expect(cache.get('a').status).toBe('miss');
    expect(cache.get('c').status).toBe('fresh');
  });

  it('runs one background refresh per key even under concurrent stale hits', async () => {
    const cache = new SearchResultCache();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = vi.fn(() => gate);

    cache.revalidate('k', refresh);
    cache.revalidate('k', refresh);
    cache.revalidate('k', refresh);
    expect(refresh).toHaveBeenCalledTimes(1);

    release();
    // The in-flight flag clears in a .finally() several links down the promise
    // chain, so flush the macrotask queue rather than counting microticks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    cache.revalidate('k', refresh);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('swallows a failing background refresh', async () => {
    const cache = new SearchResultCache();
    expect(() =>
      cache.revalidate('k', () => Promise.reject(new Error('vendor down')))
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
