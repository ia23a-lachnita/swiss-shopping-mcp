/**
 * Soft per-adapter deadline for chain fan-outs (`Promise.all` over adapters).
 * Grounded in production latency data: warm-path samples across every chain
 * stay under ~2000ms, while cold-start spikes (Playwright + VPN traversal)
 * jump straight to 4000-18000ms with nothing in between — 6000ms gives real
 * margin above the warm path without waiting anywhere near cold-start cost.
 */
export const ADAPTER_SOFT_TIMEOUT_MS = 6_000;

/**
 * Per-chain soft deadlines, replacing the single 6000ms budget for the product
 * fan-out.
 *
 * One flat budget meant the *slowest* chain set the floor for every search: a
 * chain that always times out cost a full 6s on every query, warm cache or not,
 * which is what made caching look broken. Budgets are set by transport class,
 * because that is what actually predicts the spread:
 *
 *   - JSON API (denner, volg, ottos, coop): warm p75 measured at 0.3-1.7s.
 *   - HTML scrape (aldi, lidl): a page fetch plus parse, measured up to ~4.5s.
 *   - Headless browser (migros): Playwright has to clear Cloudflare first.
 *
 * These are deliberately above each class's measured p75, not at it — the point
 * is to cut off the pathological tail, not to start failing healthy requests.
 * A chain exceeding its budget is dropped from *this* search only and reported
 * as a source warning; it is never treated as an error for the whole query.
 */
export const CHAIN_SOFT_TIMEOUT_MS: Record<string, number> = {
  coop: 3_000,
  denner: 3_000,
  volg: 3_000,
  ottos: 3_000,
  aldi: 5_000,
  lidl: 5_000,
  migros: 6_000,
};

/** Budget for `chain`, falling back to the global soft timeout for unknown chains. */
export function chainTimeoutMs(chain: string): number {
  return CHAIN_SOFT_TIMEOUT_MS[chain] ?? ADAPTER_SOFT_TIMEOUT_MS;
}

/**
 * Races `operation` against `timeoutMs`. If the timer fires first, resolves to
 * `onTimeout()` instead of waiting further — this helper does not cancel
 * anything, it only stops waiting.
 *
 * That is deliberate and it is only half of a deadline. Cancellation is
 * cooperative: an operation has to accept a signal and honour it, and some
 * cannot (Playwright exposes no `AbortSignal` at all). So the product fan-out
 * pairs this with a real one — see `SearchService.searchOneChain`, which hands
 * the adapter an `AbortSignal` *and* races it here. The signal stops the work;
 * this race guarantees the caller is never held hostage by an operation that
 * ignores it. Using either alone was a bug: the race alone leaked work for
 * nobody (tracker item 4), the signal alone let one uncooperative adapter
 * block every other chain.
 */
export async function raceWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
  });

  try {
    return await Promise.race([operation(), timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}
