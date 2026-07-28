/**
 * Tracks cumulative time the document has spent hidden (backgrounded) since
 * page load. Browsers throttle timers/fetch in hidden tabs — installed PWAs
 * especially — so a raw `performance.now()` delta around a search overstates
 * how long it "actually took" from the user's perspective if they backgrounded
 * the app mid-search. Callers snapshot `getTotalHiddenMs()` before and after
 * an operation and subtract the delta from their own elapsed-time measurement.
 */

let hiddenSince: number | undefined =
  typeof document !== 'undefined' && document.visibilityState === 'hidden' ? performance.now() : undefined;
let totalHiddenMs = 0;

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    const now = performance.now();
    if (document.visibilityState === 'hidden') {
      hiddenSince = now;
    } else if (hiddenSince !== undefined) {
      totalHiddenMs += now - hiddenSince;
      hiddenSince = undefined;
    }
  });
}

export function getTotalHiddenMs(): number {
  if (hiddenSince !== undefined) {
    return totalHiddenMs + (performance.now() - hiddenSince);
  }
  return totalHiddenMs;
}
