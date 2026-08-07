import { describe, expect, it } from 'vitest';

import {
  AdapterCallOptions,
  Chain,
  ChainAdapter,
  NormalizedProduct,
  NormalizedPromotion,
  NormalizedStore,
  ProductSearchFilters,
  PromotionSearchFilters,
  Result,
  StoreAvailabilitySupport,
  StoreProductAvailabilityFilters,
  StoreProductAvailabilityResult,
  StoreSearchFilters,
} from '../adapters/types.js';
import { SourceHttpClient, SourceClientError } from '../sources/sourceClient.js';
import { isAbortError } from '../util/cancellation.js';
import { SearchService } from './searchService.js';
import { ChainHealthBreaker } from './chainHealthBreaker.js';

/**
 * Real cancellation through the fan-out (tracker item 4).
 *
 * The behaviour under test is a *negative* one — work that must stop — so each
 * test asserts on an observable the work leaves behind (a resolved flag, a
 * breaker's state, a fetch count) rather than on a return value. A test that
 * only awaited the caller's promise would pass just as well against the old
 * "stop waiting, keep working" race, which is the bug.
 */

function product(id: string, chain: Chain): NormalizedProduct {
  return { id, chain, name: `${id} product`, price: { current: 1 } };
}

/** Adapter that honours its signal, and records whether it ran to completion. */
function cancellableAdapter(
  chain: Chain,
  delayMs: number
): ChainAdapter & { completed: () => boolean; sawSignal: () => boolean } {
  let completed = false;
  let sawSignal = false;

  return {
    chain,
    completed: () => completed,
    sawSignal: () => sawSignal,
    async searchProducts(
      _filters: ProductSearchFilters,
      options?: AdapterCallOptions
    ): Promise<Result<NormalizedProduct[]>> {
      sawSignal = options?.signal !== undefined;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          completed = true;
          resolve();
        }, delayMs);
        options?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(options.signal?.reason ?? new Error('aborted'));
          },
          { once: true }
        );
      });
      return { ok: true, data: [product('slow', chain)] };
    },
    async searchPromotions(_f: PromotionSearchFilters): Promise<Result<NormalizedPromotion[]>> {
      return { ok: true, data: [] };
    },
    async findStores(_f: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
      return { ok: true, data: [] };
    },
    getStoreAvailabilitySupport(): StoreAvailabilitySupport {
      return { chain, supported: false, reason: 'test stub' };
    },
    async lookupStoreProductAvailability(
      filters: StoreProductAvailabilityFilters
    ): Promise<Result<StoreProductAvailabilityResult>> {
      return {
        ok: true,
        data: {
          chain,
          storeId: filters.storeId,
          query: filters.query,
          supported: false,
          reason: 'test stub',
          matches: [],
          isAvailable: false,
        },
      };
    },
  };
}

describe('search cancellation', () => {
  it('hands every adapter a signal', async () => {
    const adapter = cancellableAdapter('coop', 0);
    const service = new SearchService([adapter]);

    await service.searchProducts({ query: 'milch' });

    expect(adapter.sawSignal()).toBe(true);
  });

  it('stops the adapter when the caller aborts, instead of letting it finish unattended', async () => {
    const adapter = cancellableAdapter('coop', 2_000);
    const service = new SearchService([adapter]);
    const controller = new AbortController();

    const search = service.searchProducts({ query: 'milch' }, { signal: controller.signal });
    // Abort mid-flight, the way the PWA does when the shopper edits the query.
    setTimeout(() => controller.abort(), 20);

    await expect(search).rejects.toSatisfy(isAbortError);
    // The point of the whole item: the adapter did not run to completion.
    expect(adapter.completed()).toBe(false);
  });

  it('does not blame a chain for the caller hanging up', async () => {
    // Antigravity's catch, and it would have shipped: one shopper closing a tab
    // must not book a failure against every chain and trip the breaker.
    const breaker = new ChainHealthBreaker();
    const adapter = cancellableAdapter('coop', 2_000);
    const service = new SearchService([adapter], { chainBreaker: breaker });
    const controller = new AbortController();

    const search = service.searchProducts({ query: 'milch' }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(search).rejects.toSatisfy(isAbortError);

    expect(breaker.canAttempt('coop')).toBe(true);
  });

  it('still reports a chain that runs out of its own budget as a chain failure', async () => {
    // The other half of the same distinction: a blown budget IS about the
    // chain, and must keep its SOURCE_TIMEOUT warning.
    const slow = cancellableAdapter('migros', 60_000);
    const fast = cancellableAdapter('coop', 0);
    const service = new SearchService([fast, slow]);

    const result = await service.searchProducts({ query: 'milch', chains: ['coop', 'migros'] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((p) => p.chain)).toEqual(['coop']);
      expect(result.metadata?.sourceWarnings).toEqual([
        expect.objectContaining({
          chain: 'migros',
          message: expect.stringContaining('did not respond within'),
        }),
      ]);
    }
    // And the slow chain was actually stopped, not merely abandoned.
    expect(slow.completed()).toBe(false);
  }, 20_000);

  it('leaves an uncancellable adapter unable to hold the fan-out hostage', async () => {
    // Cancellation is cooperative and Playwright cannot be interrupted at all,
    // so the deadline must not depend on the adapter agreeing to stop.
    const stubborn: ChainAdapter = {
      ...cancellableAdapter('migros', 0),
      searchProducts: () => new Promise<Result<NormalizedProduct[]>>(() => {}),
    };
    const service = new SearchService([cancellableAdapter('coop', 0), stubborn]);

    const result = await service.searchProducts({ query: 'milch', chains: ['coop', 'migros'] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((p) => p.chain)).toEqual(['coop']);
    }
  }, 20_000);
});

describe('SourceHttpClient cancellation', () => {
  it("propagates the caller's abort instead of reporting the vendor as unavailable", async () => {
    const controller = new AbortController();
    const client = new SourceHttpClient({
      rateLimitPerHostMs: 0,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        })) as typeof fetch,
    });

    const request = client.fetchText('https://example.com/x', {
      provider: 'test',
      sourceType: 'retailer-web',
      init: { signal: controller.signal },
    });
    setTimeout(() => controller.abort(), 10);

    await expect(request).rejects.toSatisfy(
      // Not a SourceClientError: a cancellation is not a source failure, and
      // dressing it as one would feed the retry set and the circuit breaker.
      (error: unknown) => isAbortError(error) && !(error instanceof SourceClientError)
    );
  });

  it('does not dispatch at all when the signal is already aborted', async () => {
    let calls = 0;
    const client = new SourceHttpClient({
      rateLimitPerHostMs: 0,
      fetchImpl: (async () => {
        calls += 1;
        return new Response('{}');
      }) as typeof fetch,
    });

    await expect(
      client.fetchText('https://example.com/x', {
        provider: 'test',
        sourceType: 'retailer-web',
        init: { signal: AbortSignal.abort() },
      })
    ).rejects.toSatisfy(isAbortError);

    expect(calls).toBe(0);
  });
});
