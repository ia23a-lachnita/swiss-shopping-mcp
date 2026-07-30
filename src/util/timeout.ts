/**
 * Soft per-adapter deadline for chain fan-outs (`Promise.all` over adapters).
 * Grounded in production latency data: warm-path samples across every chain
 * stay under ~2000ms, while cold-start spikes (Playwright + VPN traversal)
 * jump straight to 4000-18000ms with nothing in between — 6000ms gives real
 * margin above the warm path without waiting anywhere near cold-start cost.
 */
export const ADAPTER_SOFT_TIMEOUT_MS = 6_000;

/**
 * Races `operation` against `timeoutMs`. If the timer fires first, resolves
 * to `onTimeout()` instead of waiting further — the underlying operation is
 * not cancelled, just no longer waited on, so a slow adapter can still
 * complete in the background without blocking the caller.
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
