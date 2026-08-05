import { describe, expect, it } from 'vitest';

import {
  classify429,
  createRateLimitedFetch,
  FreeTierRateLimiter,
  modelFromRequest,
  RateLimitedError,
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

/**
 * The 429 that actually arrived on 2026-08-05 — a busy provider pool, whose
 * `previous_errors` still mention the account's per-minute limit. Reading that
 * mention as an account limit is the trap: it blocked every request in the
 * process for a minute and failed nine eval cases that never reached the
 * network.
 */
const UPSTREAM_POOL_BODY = JSON.stringify({
  error: {
    message: 'Provider returned error',
    code: 429,
    metadata: {
      raw: 'google/gemma-4-31b-it:free is temporarily rate-limited upstream.',
      provider_name: 'Google AI Studio',
      limit_source: 'upstream_provider_shared_pool',
      previous_errors: [{ code: 429, message: 'Rate limit exceeded: free-models-per-min. ' }],
    },
  },
});

describe('classify429', () => {
  it('reads a busy provider pool as upstream even when the body mentions our per-minute limit', () => {
    expect(classify429(new Headers(), UPSTREAM_POOL_BODY)).toBe('upstream');
  });

  it('reads an explicit account limit_source as ours', () => {
    const body = JSON.stringify({ error: { metadata: { limit_source: 'account' } } });
    expect(classify429(new Headers(), body)).toBe('account-per-minute');
  });

  it('separates the daily cap, which no amount of waiting fixes', () => {
    expect(classify429(new Headers(), 'Rate limit exceeded: free-models-per-day')).toBe('account-per-day');
  });

  it('falls back to the account wording, then to the platform headers', () => {
    expect(classify429(new Headers(), 'Rate limit exceeded: free-models-per-min. ')).toBe(
      'account-per-minute'
    );
    expect(classify429(new Headers({ 'x-ratelimit-limit': '20' }), 'no idea')).toBe('account-per-minute');
  });

  it('defaults an unclassifiable 429 to upstream, never to a process-wide block', () => {
    // Guessing "account" here stops every request we make; that blast radius is
    // not something to take on a guess.
    expect(classify429(new Headers(), 'something new openrouter has not documented')).toBe('upstream');
  });
});

describe('FreeTierRateLimiter', () => {
  it('paces requests once the window is full instead of firing them all', async () => {
    const clock = fakeClock();
    const limiter = new FreeTierRateLimiter(3, clock);
    const startedAt = clock.now();

    for (let i = 0; i < 3; i += 1) await limiter.acquire(far);
    expect(clock.now()).toBe(startedAt);

    await limiter.acquire(far);
    expect(clock.now()).toBe(startedAt + 60_000);
  });

  it('serializes admission so concurrent callers cannot both take the last slot', async () => {
    const clock = fakeClock();
    const limiter = new FreeTierRateLimiter(2, clock);

    await Promise.all([limiter.acquire(far), limiter.acquire(far), limiter.acquire(far)]);

    expect(clock.now()).toBe(1_000_000 + 60_000);
  });

  it('makes every queued caller wait out an account limit, not just the one that hit it', async () => {
    const clock = fakeClock();
    const limiter = new FreeTierRateLimiter(100, clock);

    limiter.noteAccountRateLimited(5_000);
    await limiter.acquire(far);

    expect(clock.now()).toBe(1_000_000 + 5_000);
  });

  it('confines a model cooldown to that model', async () => {
    const clock = fakeClock();
    const limiter = new FreeTierRateLimiter(100, clock);

    limiter.noteModelCooldown('google/gemma-4-31b-it:free', 20_000);

    await limiter.acquire(far, 'openai/gpt-oss-20b:free');
    expect(clock.now()).toBe(1_000_000); // an unrelated model is unaffected

    await limiter.acquire(far, 'google/gemma-4-31b-it:free');
    expect(clock.now()).toBe(1_000_000 + 20_000);
  });

  it('refuses rather than sleeping past the caller’s queue budget', async () => {
    const clock = fakeClock();
    const limiter = new FreeTierRateLimiter(100, clock);
    limiter.noteAccountRateLimited(40_000);

    await expect(limiter.acquire(clock.now() + 10_000)).rejects.toBeInstanceOf(RateLimitedError);
    expect(clock.now()).toBe(1_000_000); // did not sleep
  });

  it('keeps serving later callers after one is refused', async () => {
    const clock = fakeClock();
    const limiter = new FreeTierRateLimiter(100, clock);
    limiter.noteAccountRateLimited(40_000);

    await expect(limiter.acquire(clock.now() + 1_000)).rejects.toBeInstanceOf(RateLimitedError);
    await expect(limiter.acquire(far)).resolves.toBeUndefined();
  });

  it('escalates the headerless backoff from 2s instead of assuming a whole window', () => {
    const clock = fakeClock();
    const limiter = new FreeTierRateLimiter(100, clock);

    expect(limiter.headerlessBackoffMs()).toBe(2_000);
    expect(limiter.headerlessBackoffMs()).toBe(4_000);
    expect(limiter.headerlessBackoffMs()).toBe(8_000);

    limiter.noteSuccess();
    expect(limiter.headerlessBackoffMs()).toBe(2_000);
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
    expect(retryAfterMsFrom(new Headers({ 'x-ratelimit-reset': String(inSeconds) }), now)).toBeLessThanOrEqual(
      8_000
    );
  });

  it('returns undefined when the response says nothing useful', () => {
    expect(retryAfterMsFrom(new Headers(), now)).toBeUndefined();
    expect(retryAfterMsFrom(new Headers({ 'x-ratelimit-reset': '0' }), now)).toBeUndefined();
  });
});

describe('modelFromRequest', () => {
  it('pulls the model id out of an outgoing request, for per-model cooldowns', () => {
    expect(modelFromRequest({ body: JSON.stringify({ model: 'openai/gpt-oss-20b:free' }) })).toBe(
      'openai/gpt-oss-20b:free'
    );
    expect(modelFromRequest({ body: 'not json' })).toBeUndefined();
    expect(modelFromRequest({})).toBeUndefined();
  });
});

describe('createRateLimitedFetch', () => {
  function response(status: number, body = '{}', headers: Record<string, string> = {}): Response {
    return new Response(body, { status, headers });
  }
  const chatRequest = { body: JSON.stringify({ model: 'google/gemma-4-31b-it:free' }) };

  it('retries an account limit once, after the wait the response asked for', async () => {
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

    const rateLimitedFetch = createRateLimitedFetch({ queueDeadline: far, limiter, clock, fetchImpl });
    const result = await rateLimitedFetch('https://openrouter.example/chat', chatRequest);

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

    const rateLimitedFetch = createRateLimitedFetch({ queueDeadline: far, limiter, clock, fetchImpl });

    await expect(rateLimitedFetch('https://openrouter.example/chat', chatRequest)).rejects.toMatchObject({
      name: 'RateLimitedError',
      scope: 'account-per-day',
    });
    expect(calls).toBe(1);
  });

  it('retries a busy provider pool briefly and leaves unrelated traffic alone', async () => {
    const clock = fakeClock();
    const limiter = new FreeTierRateLimiter(100, clock);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1 ? response(429, UPSTREAM_POOL_BODY) : response(200, 'ok');
    }) as unknown as typeof fetch;

    const rateLimitedFetch = createRateLimitedFetch({ queueDeadline: far, limiter, clock, fetchImpl });
    const result = await rateLimitedFetch('https://openrouter.example/chat', chatRequest);

    expect(result.status).toBe(200);
    expect(calls).toBe(2);
    // The whole point: a pool hiccup on one model must not queue everyone else.
    const before = clock.now();
    await limiter.acquire(far, 'openai/gpt-oss-20b:free');
    expect(clock.now()).toBe(before);
  });

  it('cools down only the offending model when its pool keeps refusing', async () => {
    const clock = fakeClock();
    const limiter = new FreeTierRateLimiter(100, clock);
    const fetchImpl = (async () => response(429, UPSTREAM_POOL_BODY)) as unknown as typeof fetch;

    const rateLimitedFetch = createRateLimitedFetch({ queueDeadline: far, limiter, clock, fetchImpl });

    await expect(rateLimitedFetch('https://openrouter.example/chat', chatRequest)).rejects.toMatchObject({
      name: 'RateLimitedError',
      scope: 'upstream',
      model: 'google/gemma-4-31b-it:free',
    });

    const before = clock.now();
    await limiter.acquire(far, 'openai/gpt-oss-20b:free');
    expect(clock.now()).toBe(before); // other models still flow

    await limiter.acquire(far, 'google/gemma-4-31b-it:free');
    expect(clock.now()).toBeGreaterThan(before); // the offender waits out its cooldown
  });

  it('passes non-429 responses straight through', async () => {
    const clock = fakeClock();
    const limiter = new FreeTierRateLimiter(100, clock);
    const fetchImpl = (async () => response(200, 'ok')) as unknown as typeof fetch;

    const rateLimitedFetch = createRateLimitedFetch({ queueDeadline: far, limiter, clock, fetchImpl });
    const result = await rateLimitedFetch('https://openrouter.example/chat', chatRequest);

    expect(result.status).toBe(200);
    expect(await result.text()).toBe('ok');
  });
});
