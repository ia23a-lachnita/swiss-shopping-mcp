import { describe, expect, it } from 'vitest';

import {
  createRateLimitedFetch,
  FreeTierRateLimiter,
  RateLimitedError,
  rateLimitScopeFrom,
  retryAfterMsFrom,
  type RateLimiterClock,
} from './openRouterRateLimit.js';

/** Virtual clock: sleeping advances time instead of costing any. */
function fakeClock(start = 1_000_000): RateLimiterClock & { advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const far = Number.MAX_SAFE_INTEGER;

describe('FreeTierRateLimiter', () => {
  it('paces requests once the window is full instead of firing them all', async () => {
    const clock = fakeClock();
    const limiter = new FreeTierRateLimiter(3, clock);
    const startedAt = clock.now();

    for (let i = 0; i < 3; i += 1) await limiter.acquire(far);
    expect(clock.now()).toBe(startedAt); // first three go straight through

    await limiter.acquire(far); // fourth must wait for the oldest to age out
    expect(clock.now()).toBe(startedAt + 60_000);
  });

  it('serializes admission so concurrent callers cannot both take the last slot', async () => {
    const clock = fakeClock();
    const limiter = new FreeTierRateLimiter(2, clock);

    await Promise.all([limiter.acquire(far), limiter.acquire(far), limiter.acquire(far)]);

    // Three requests, a limit of two: the third had to wait out the window.
    expect(clock.now()).toBe(1_000_000 + 60_000);
  });

  it('makes every queued caller wait out a 429, not just the one that hit it', async () => {
    const clock = fakeClock();
    const limiter = new FreeTierRateLimiter(100, clock); // window is not the constraint here

    limiter.noteRateLimited(5_000);
    await limiter.acquire(far);

    expect(clock.now()).toBe(1_000_000 + 5_000);
  });

  it('refuses rather than sleeping past the caller’s own deadline', async () => {
    const clock = fakeClock();
    const limiter = new FreeTierRateLimiter(100, clock);
    limiter.noteRateLimited(40_000);

    // A 40s wait against a 10s budget: failing clearly beats stalling into an
    // opaque abort, which is how the original failure presented.
    await expect(limiter.acquire(clock.now() + 10_000)).rejects.toBeInstanceOf(RateLimitedError);
    expect(clock.now()).toBe(1_000_000); // did not sleep
  });

  it('keeps serving later callers after one is refused', async () => {
    const clock = fakeClock();
    const limiter = new FreeTierRateLimiter(100, clock);
    limiter.noteRateLimited(40_000);

    await expect(limiter.acquire(clock.now() + 1_000)).rejects.toBeInstanceOf(RateLimitedError);
    await expect(limiter.acquire(far)).resolves.toBeUndefined();
  });
});

describe('retryAfterMsFrom', () => {
  const now = 1_700_000_000_000;

  it('reads Retry-After in seconds', () => {
    expect(retryAfterMsFrom(new Headers({ 'retry-after': '12' }), now)).toBe(12_000);
  });

  it('reads Retry-After as an HTTP date', () => {
    const when = new Date(now + 30_000).toUTCString();
    expect(retryAfterMsFrom(new Headers({ 'retry-after': when }), now)).toBeGreaterThan(29_000);
  });

  it('falls back to X-RateLimit-Reset in either unit', () => {
    expect(retryAfterMsFrom(new Headers({ 'x-ratelimit-reset': String(now + 8_000) }), now)).toBe(8_000);
    const inSeconds = Math.floor((now + 8_000) / 1000);
    expect(retryAfterMsFrom(new Headers({ 'x-ratelimit-reset': String(inSeconds) }), now)).toBeLessThanOrEqual(8_000);
  });

  it('returns undefined when the response says nothing useful', () => {
    expect(retryAfterMsFrom(new Headers(), now)).toBeUndefined();
    expect(retryAfterMsFrom(new Headers({ 'x-ratelimit-reset': '0' }), now)).toBeUndefined();
  });
});

describe('rateLimitScopeFrom', () => {
  it('recognises the per-minute limit from the observed body', () => {
    expect(rateLimitScopeFrom('{"error":{"message":"Rate limit exceeded: free-models-per-min. "}}')).toBe(
      'per-minute'
    );
  });

  it('recognises the daily limit, which retrying cannot fix', () => {
    expect(rateLimitScopeFrom('Rate limit exceeded: free-models-per-day')).toBe('per-day');
  });
});

describe('createRateLimitedFetch', () => {
  function response(status: number, body = '{}', headers: Record<string, string> = {}): Response {
    return new Response(body, { status, headers });
  }

  it('retries a per-minute 429 once, after the wait the response asked for', async () => {
    const clock = fakeClock();
    const limiter = new FreeTierRateLimiter(100, clock);
    const calls: number[] = [];
    const fetchImpl = (async () => {
      calls.push(clock.now());
      return calls.length === 1
        ? response(429, '{"error":{"message":"Rate limit exceeded: free-models-per-min."}}', {
            'retry-after': '7',
          })
        : response(200, 'ok');
    }) as unknown as typeof fetch;

    const rateLimitedFetch = createRateLimitedFetch({
      deadline: far,
      limiter,
      clock,
      fetchImpl,
    });

    const result = await rateLimitedFetch('https://openrouter.ai/api/v1/chat/completions');

    expect(result.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1] - calls[0]).toBe(7_000); // waited exactly as long as told
  });

  it('does not retry a daily limit — the quota is gone until tomorrow', async () => {
    const clock = fakeClock();
    const limiter = new FreeTierRateLimiter(100, clock);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return response(429, '{"error":{"message":"Rate limit exceeded: free-models-per-day."}}');
    }) as unknown as typeof fetch;

    const rateLimitedFetch = createRateLimitedFetch({ deadline: far, limiter, clock, fetchImpl });

    await expect(rateLimitedFetch('https://openrouter.ai/api/v1/chat/completions')).rejects.toMatchObject({
      name: 'RateLimitedError',
      scope: 'per-day',
    });
    expect(calls).toBe(1);
  });

  it('gives up with a stated wait rather than hammering a closed window', async () => {
    const clock = fakeClock();
    const limiter = new FreeTierRateLimiter(100, clock);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return response(429, 'free-models-per-min', { 'retry-after': '3' });
    }) as unknown as typeof fetch;

    const rateLimitedFetch = createRateLimitedFetch({ deadline: far, limiter, clock, fetchImpl });

    await expect(rateLimitedFetch('https://openrouter.ai/api/v1/chat/completions')).rejects.toMatchObject({
      name: 'RateLimitedError',
      retryAfterMs: 3_000,
    });
    expect(calls).toBe(2); // one retry, then a clear error — not three blind ones
  });

  it('passes non-429 responses straight through', async () => {
    const clock = fakeClock();
    const limiter = new FreeTierRateLimiter(100, clock);
    const fetchImpl = (async () => response(200, 'ok')) as unknown as typeof fetch;

    const rateLimitedFetch = createRateLimitedFetch({ deadline: far, limiter, clock, fetchImpl });
    const result = await rateLimitedFetch('https://openrouter.ai/api/v1/chat/completions');

    expect(result.status).toBe(200);
    expect(await result.text()).toBe('ok');
  });
});
