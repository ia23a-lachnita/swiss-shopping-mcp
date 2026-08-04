// Rate-limit discipline for the OpenRouter free tier.
//
// Why this exists: on 2026-08-04 the golden-eval came back 8/10 red with
// `429 free-models-per-min`, and the first reading was "upstream problem".
// It was not. The limits are published, we ran straight at them, and then
// made it worse:
//
//   - The cap is **20 requests/minute across every `:free` model on the
//     account** — not per model. `FALLBACK_MODEL_IDS` is three `:free` ids,
//     so OpenRouter's own `models` fallback chain cannot rescue a 429: every
//     entry in it is already rate-limited by the same counter. That was a
//     design flaw in the config, not bad luck.
//   - The eval runs ten cases sequentially, each of which is one or two model
//     requests. That sits on the cap by itself.
//   - Once limited, the AI SDK's blind exponential retry fired three more
//     requests per failure, which is the one thing guaranteed to keep you
//     limited.
//
// So: pace requests below the documented cap, share that state across every
// caller in the process, and when a 429 does arrive, wait exactly as long as
// OpenRouter says to instead of guessing.
//
// Limits and headers below are quoted from
// https://openrouter.ai/docs/api-reference/limits, read 2026-08-04. Re-read
// before trusting them; the free tier's terms move.

/** Documented cap on `:free` model requests per minute, per account. */
export const FREE_MODEL_RPM = 20;
/** Documented daily caps: without any lifetime credit purchase, and with ≥$10. */
export const FREE_MODEL_RPD_NO_CREDITS = 50;
export const FREE_MODEL_RPD_WITH_CREDITS = 1000;

/**
 * What we actually allow ourselves. Below the cap on purpose: the counter is
 * account-wide, so a second process (a dev shell running `test:eval` while the
 * server serves chat) shares it, and a limiter pinned exactly at 20 would
 * hand out the token that trips it.
 */
const SELF_IMPOSED_RPM = 16;
const WINDOW_MS = 60_000;

export type RateLimitScope = 'per-minute' | 'per-day' | 'unknown';

export class RateLimitedError extends Error {
  public constructor(
    message: string,
    public readonly scope: RateLimitScope,
    public readonly retryAfterMs: number
  ) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

export interface RateLimiterClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: RateLimiterClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * A sliding-window admission gate shared by every free-tier request in the
 * process. Admission is serialized, so two concurrent callers cannot both read
 * "19 used" and both proceed.
 */
export class FreeTierRateLimiter {
  private readonly dispatched: number[] = [];
  private blockedUntil = 0;
  private admission: Promise<void> = Promise.resolve();

  public constructor(
    private readonly limitPerWindow: number = SELF_IMPOSED_RPM,
    private readonly clock: RateLimiterClock = realClock
  ) {}

  /**
   * Wait until sending is within budget.
   *
   * `deadline` is an absolute timestamp — this never sleeps past it. Sleeping
   * into your own abort just converts a clear "rate limited for 40s" into an
   * opaque timeout, which is how the original failure read.
   */
  public async acquire(deadline: number): Promise<void> {
    const mine = this.admission.then(() => this.admit(deadline));
    // Keep the chain alive even if this admission rejects, or one refused
    // request would poison every later one.
    this.admission = mine.catch(() => undefined);
    return mine;
  }

  private async admit(deadline: number): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      this.forgetOlderThan(now - WINDOW_MS);

      const waitForWindow =
        this.dispatched.length >= this.limitPerWindow
          ? this.dispatched[0] + WINDOW_MS - now
          : 0;
      const waitForBlock = this.blockedUntil - now;
      const waitMs = Math.max(waitForWindow, waitForBlock, 0);

      if (waitMs === 0) {
        this.dispatched.push(now);
        return;
      }
      if (now + waitMs > deadline) {
        throw new RateLimitedError(
          `OpenRouter free-tier rate limit: the next slot is ${Math.ceil(waitMs / 1000)}s away, ` +
            `which is longer than this request's remaining budget.`,
          waitForBlock > waitForWindow ? 'unknown' : 'per-minute',
          waitMs
        );
      }
      await this.clock.sleep(waitMs);
    }
  }

  /**
   * Record a 429 so *every* queued request waits it out, not just the one that
   * happened to hit it. Returns how long OpenRouter asked us to wait.
   */
  public noteRateLimited(retryAfterMs: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.clock.now() + retryAfterMs);
  }

  /** Test seam: how many requests the window currently holds. */
  public get inWindow(): number {
    this.forgetOlderThan(this.clock.now() - WINDOW_MS);
    return this.dispatched.length;
  }

  private forgetOlderThan(cutoff: number): void {
    while (this.dispatched.length > 0 && this.dispatched[0] <= cutoff) {
      this.dispatched.shift();
    }
  }
}

/** Process-wide, because the limit OpenRouter enforces is account-wide. */
export const freeTierLimiter = new FreeTierRateLimiter();

/** `Retry-After` is seconds or an HTTP date; `X-RateLimit-Reset` is a timestamp. */
export function retryAfterMsFrom(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }

  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    // Documented as a timestamp, but seen in both units in the wild: anything
    // below ~10^11 is seconds, above is milliseconds.
    const resetMs = reset < 1e11 ? reset * 1000 : reset;
    const delta = resetMs - now;
    if (delta > 0 && delta < 24 * 60 * 60 * 1000) return delta;
  }

  return undefined;
}

/**
 * Which limit was hit. Worth separating: waiting out a per-minute limit works,
 * waiting out a daily one does not — that one needs a different model tier or
 * tomorrow, and retrying just burns the remaining quota.
 */
export function rateLimitScopeFrom(body: string): RateLimitScope {
  const lower = body.toLowerCase();
  if (lower.includes('per-day') || lower.includes('per-d') || lower.includes('daily')) return 'per-day';
  if (lower.includes('per-min') || lower.includes('free-models-per-minute')) return 'per-minute';
  return 'unknown';
}

export interface RateLimitedFetchOptions {
  /** Absolute timestamp this request must not outlive (matches the caller's abort budget). */
  deadline: number;
  limiter?: FreeTierRateLimiter;
  clock?: RateLimiterClock;
  fetchImpl?: typeof fetch;
}

/**
 * `fetch` for the OpenRouter provider that paces itself and honors a 429's own
 * retry hint. One retry, deliberately: a second one cannot beat a per-minute
 * window that the first already waited out, and the SDK still has its own
 * retry above us for transient non-429 failures.
 */
export function createRateLimitedFetch(options: RateLimitedFetchOptions): typeof fetch {
  const limiter = options.limiter ?? freeTierLimiter;
  const clock = options.clock ?? realClock;
  const doFetch = options.fetchImpl ?? fetch;

  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    for (let attempt = 0; ; attempt += 1) {
      await limiter.acquire(options.deadline);
      const response = await doFetch(input, init);
      if (response.status !== 429) return response;

      const now = clock.now();
      const body = await response.clone().text();
      const scope = rateLimitScopeFrom(body);
      const retryAfterMs = retryAfterMsFrom(response.headers, now) ?? WINDOW_MS;
      limiter.noteRateLimited(retryAfterMs);

      if (scope === 'per-day') {
        throw new RateLimitedError(
          `OpenRouter free-tier daily limit reached (${FREE_MODEL_RPD_NO_CREDITS}/day without credits, ` +
            `${FREE_MODEL_RPD_WITH_CREDITS} with ≥$${10}). Retrying will not help today.`,
          scope,
          retryAfterMs
        );
      }
      if (attempt >= 1 || now + retryAfterMs > options.deadline) {
        throw new RateLimitedError(
          `OpenRouter free-tier rate limit (${FREE_MODEL_RPM} requests/minute across all :free models). ` +
            `Retry possible in ${Math.ceil(retryAfterMs / 1000)}s.`,
          scope,
          retryAfterMs
        );
      }
      // Loop: `acquire` now blocks on the recorded window, so the wait happens
      // in the gate where every other caller sees it too.
    }
  };
}
