// Rate-limit discipline for the OpenRouter free tier.
//
// Why this exists: on 2026-08-04 the golden-eval came back 8/10 red with
// `429 free-models-per-min`, and the first reading was "upstream problem".
// It was not. The limits are published, we ran straight at them, and then
// made it worse:
//
//   - The account cap is **20 requests/minute across every `:free` model** —
//     not per model. `FALLBACK_MODEL_IDS` is three `:free` ids, so
//     OpenRouter's own `models` chain cannot rescue *that* 429: every entry
//     shares the counter. That was a design flaw in the config, not bad luck.
//   - The eval runs ten cases sequentially, each one or two model requests.
//     That sits on the cap by itself.
//   - Once limited, the SDK's blind exponential retry fired three more
//     requests per failure, which is the one thing guaranteed to keep you
//     limited.
//
// The first version of this file then made a *new* version of the same
// mistake, caught by running it: it treated every 429 as account-level and
// blocked all traffic for 60s, so one transient provider-pool hiccup failed
// nine eval cases that never reached the network. Hence the taxonomy below —
// reviewed with antigravity-mcp/gemini-3.6-flash, whose sharpest correction
// was that an *unclassifiable* 429 must default to the narrow, per-model
// reading, never the catastrophic global one.
//
// Limits and headers are from https://openrouter.ai/docs/api-reference/limits,
// read 2026-08-04. Re-read before trusting them; the free tier's terms move.

/** Documented cap on `:free` model requests per minute, per account. */
export const FREE_MODEL_RPM = 20;
/**
 * Documented daily caps. **This project's account is credit-verified, so the
 * applicable number is 1000/day** — the 50 applies only to accounts that never
 * purchased credits. Which means the per-minute cap is the binding constraint
 * here, and a live eval run is cheap: pace it, don't avoid it.
 */
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

/** Backoff when an account-level 429 arrives with no Retry-After to honor. */
const HEADERLESS_BACKOFF_START_MS = 2_000;
const HEADERLESS_BACKOFF_CAP_MS = WINDOW_MS;

/** A provider pool that is momentarily busy usually clears in well under a second. */
const UPSTREAM_RETRY_DELAYS_MS = [500, 1_500];
/** How long to stop offering a model that keeps coming back pool-limited. */
const UPSTREAM_MODEL_COOLDOWN_MS = 20_000;

/**
 * `account-*` limits apply to every request we make and are ours to pace.
 * `upstream` is one provider's pool being busy: a different model or provider
 * would work, so it must never stop unrelated traffic.
 */
export type RateLimitScope = 'account-per-minute' | 'account-per-day' | 'upstream';

export class RateLimitedError extends Error {
  public constructor(
    message: string,
    public readonly scope: RateLimitScope,
    public readonly retryAfterMs: number,
    public readonly model?: string
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
 * Which limit was hit, keyed on the most durable signal available.
 *
 * Tiers, most to least trustworthy: OpenRouter's own `metadata.limit_source`;
 * then the account-limit wording (only reachable when `limit_source` is
 * absent, so an upstream body carrying `free-models-per-min` in its
 * `previous_errors` cannot be misread as ours); then the presence of the
 * platform's rate-limit headers, which its edge attaches to account limits and
 * proxied upstream errors generally lack.
 *
 * The default is deliberately `upstream`: guessing "account" on an
 * unclassifiable 429 stops every request in the process, and that blast radius
 * is not something to take on a guess.
 */
export function classify429(headers: Headers, body: string): RateLimitScope {
  const limitSource = readLimitSource(body);
  if (limitSource?.startsWith('upstream')) return 'upstream';
  if (limitSource === 'account' || limitSource === 'key') {
    return /per-?day|daily/i.test(body) ? 'account-per-day' : 'account-per-minute';
  }

  if (limitSource === undefined) {
    if (/free-models-per-?day|per-?day|daily/i.test(body)) return 'account-per-day';
    if (/free-models-per-?min/i.test(body)) return 'account-per-minute';
    if (headers.has('x-ratelimit-limit') || headers.has('retry-after')) {
      return 'account-per-minute';
    }
  }

  return 'upstream';
}

function readLimitSource(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const source = (parsed as { error?: { metadata?: { limit_source?: unknown } } })?.error?.metadata
      ?.limit_source;
    return typeof source === 'string' ? source : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort model id from an outgoing chat-completions body, for cooldowns. */
export function modelFromRequest(init?: { body?: unknown }): string | undefined {
  if (typeof init?.body !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(init.body);
    const model = (parsed as { model?: unknown }).model;
    return typeof model === 'string' ? model : undefined;
  } catch {
    return undefined;
  }
}

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
 * A sliding-window admission gate shared by every free-tier request in the
 * process. Admission is serialized, so two concurrent callers cannot both read
 * "19 used" and both proceed.
 */
export class FreeTierRateLimiter {
  private readonly dispatched: number[] = [];
  private readonly modelCooldowns = new Map<string, number>();
  private blockedUntil = 0;
  private consecutiveHeaderlessLimits = 0;
  private admission: Promise<void> = Promise.resolve();

  public constructor(
    private readonly limitPerWindow: number = SELF_IMPOSED_RPM,
    private readonly clock: RateLimiterClock = realClock
  ) {}

  /**
   * Wait until sending is within budget.
   *
   * `queueDeadline` is an absolute timestamp bounding how long this caller is
   * willing to *wait in line* — which is not the same budget as how long the
   * model may take to answer, and conflating the two was a bug: a batch eval
   * happily waits a minute for a slot, while an interactive chat turn does
   * not. Never sleeps past it; a refusal with a stated wait beats stalling
   * into an opaque abort.
   */
  public async acquire(queueDeadline: number, model?: string): Promise<void> {
    const mine = this.admission.then(() => this.admit(queueDeadline, model));
    // Keep the chain alive even if this admission rejects, or one refused
    // request would poison every later one.
    this.admission = mine.catch(() => undefined);
    return mine;
  }

  private async admit(queueDeadline: number, model?: string): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      this.forgetOlderThan(now - WINDOW_MS);

      const waitForWindow =
        this.dispatched.length >= this.limitPerWindow ? this.dispatched[0] + WINDOW_MS - now : 0;
      const waitForBlock = this.blockedUntil - now;
      const cooldownUntil = model ? (this.modelCooldowns.get(model) ?? 0) : 0;
      const waitForModel = cooldownUntil - now;
      const waitMs = Math.max(waitForWindow, waitForBlock, waitForModel, 0);

      if (waitMs === 0) {
        this.dispatched.push(now);
        return;
      }
      if (now + waitMs > queueDeadline) {
        const scope: RateLimitScope = waitForModel === waitMs ? 'upstream' : 'account-per-minute';
        throw new RateLimitedError(
          scope === 'upstream'
            ? `${model ?? 'That model'} is in a ${Math.ceil(waitMs / 1000)}s cooldown after repeated ` +
              `provider-pool rate limits, which is longer than this request may wait.`
            : `OpenRouter free-tier rate limit: the next slot is ${Math.ceil(waitMs / 1000)}s away, ` +
              `which is longer than this request may wait.`,
          scope,
          waitMs,
          model
        );
      }
      await this.clock.sleep(waitMs);
    }
  }

  /**
   * Record an account-level 429 so *every* queued request waits it out, not
   * just the one that happened to hit it. Only account limits belong here: an
   * upstream pool limit says nothing about our other traffic.
   */
  public noteAccountRateLimited(retryAfterMs: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.clock.now() + retryAfterMs);
  }

  /** Stop offering one model for a while after its provider pool keeps refusing. */
  public noteModelCooldown(model: string, ms: number): void {
    this.modelCooldowns.set(model, Math.max(this.modelCooldowns.get(model) ?? 0, this.clock.now() + ms));
  }

  /**
   * How long to wait for an account limit that arrived without a `Retry-After`.
   * Escalates from 2s rather than assuming a full window: a single transient
   * headerless 429 should not lock the pipeline for a minute. Floored by our
   * own window age-out, which is the earliest a slot can free from our side —
   * and only a floor, since another process on the same key may have filled
   * the account's counter beyond what we can see.
   */
  public headerlessBackoffMs(): number {
    const step = Math.min(
      HEADERLESS_BACKOFF_START_MS * 2 ** this.consecutiveHeaderlessLimits,
      HEADERLESS_BACKOFF_CAP_MS
    );
    this.consecutiveHeaderlessLimits += 1;

    const now = this.clock.now();
    this.forgetOlderThan(now - WINDOW_MS);
    const windowAgeOut =
      this.dispatched.length >= this.limitPerWindow ? this.dispatched[0] + WINDOW_MS - now : 0;

    return Math.min(Math.max(step, windowAgeOut), HEADERLESS_BACKOFF_CAP_MS);
  }

  /** A clean response means the escalation above starts over. */
  public noteSuccess(): void {
    this.consecutiveHeaderlessLimits = 0;
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

export interface RateLimitedFetchOptions {
  /** Absolute timestamp bounding how long a request may wait *in line* for a slot. */
  queueDeadline: number;
  limiter?: FreeTierRateLimiter;
  clock?: RateLimiterClock;
  fetchImpl?: typeof fetch;
}

/**
 * `fetch` for the OpenRouter provider that paces itself and answers each kind
 * of 429 with the response it actually deserves:
 *
 * - account per-minute → wait it out, for everyone, honoring `Retry-After`;
 * - account per-day → do not retry at all, the quota is gone until tomorrow;
 * - upstream provider pool → two short jittered retries, then a cooldown on
 *   that model alone, leaving every other request untouched.
 */
export function createRateLimitedFetch(options: RateLimitedFetchOptions): typeof fetch {
  const limiter = options.limiter ?? freeTierLimiter;
  const clock = options.clock ?? realClock;
  const doFetch = options.fetchImpl ?? fetch;

  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const model = modelFromRequest(init);
    let upstreamAttempts = 0;
    let accountRetried = false;

    for (;;) {
      await limiter.acquire(options.queueDeadline, model);
      const response = await doFetch(input, init);
      if (response.status !== 429) {
        limiter.noteSuccess();
        return response;
      }

      const now = clock.now();
      const body = await response.clone().text();
      const scope = classify429(response.headers, body);
      const headerRetryAfterMs = retryAfterMsFrom(response.headers, now);

      if (scope === 'account-per-day') {
        throw new RateLimitedError(
          `OpenRouter free-tier daily limit reached (${FREE_MODEL_RPD_WITH_CREDITS}/day on a ` +
            `credit-verified account, ${FREE_MODEL_RPD_NO_CREDITS} without). Retrying will not help today.`,
          scope,
          headerRetryAfterMs ?? 0,
          model
        );
      }

      if (scope === 'account-per-minute') {
        const retryAfterMs = headerRetryAfterMs ?? limiter.headerlessBackoffMs();
        limiter.noteAccountRateLimited(retryAfterMs);
        if (accountRetried || now + retryAfterMs > options.queueDeadline) {
          throw new RateLimitedError(
            `OpenRouter free-tier rate limit (${FREE_MODEL_RPM} requests/minute across all :free models). ` +
              `Retry possible in ${Math.ceil(retryAfterMs / 1000)}s.`,
            scope,
            retryAfterMs,
            model
          );
        }
        accountRetried = true;
        continue; // `acquire` now blocks on the recorded window, where every caller sees it
      }

      // Upstream pool: this model, this moment. Nothing to tell the other
      // callers, so the limiter's global state stays untouched.
      if (upstreamAttempts < UPSTREAM_RETRY_DELAYS_MS.length) {
        const base = UPSTREAM_RETRY_DELAYS_MS[upstreamAttempts];
        upstreamAttempts += 1;
        await clock.sleep(base + Math.floor(Math.random() * base)); // full jitter
        continue;
      }
      if (model) limiter.noteModelCooldown(model, UPSTREAM_MODEL_COOLDOWN_MS);
      throw new RateLimitedError(
        `${model ?? 'The model'}'s provider pool is rate-limiting us (this is upstream, not our ` +
          `account quota). A different model would likely answer — this is what the models fallback ` +
          `chain is for.`,
        scope,
        headerRetryAfterMs ?? UPSTREAM_MODEL_COOLDOWN_MS,
        model
      );
    }
  };
}
