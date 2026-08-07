/**
 * Cancellation helpers shared by the transport, the adapters and the fan-out.
 *
 * The whole point of item 4 in the tracker: a soft timeout that stops *waiting*
 * is not a timeout that stops *working*. These are the pieces every layer needs
 * to agree on so one abort actually reaches the socket.
 */

/**
 * Both cancellation shapes, in one predicate.
 *
 * `controller.abort()` produces a `DOMException` named `AbortError`;
 * `AbortSignal.timeout()` produces one named `TimeoutError`. Checking only for
 * `AbortError` — the reflex, and what most snippets show — silently misses
 * every deadline-driven cancellation in this codebase, which is most of them.
 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * The signal's own reason, so `TimeoutError` and `AbortError` stay
 * distinguishable downstream — a chain that ran out of budget and a shopper who
 * closed the tab are different events, and only one of them is about the chain.
 */
export function abortReason(signal: AbortSignal, context: string): Error {
  const reason = signal.reason as unknown;
  if (reason instanceof Error) return reason;
  return Object.assign(new Error(`${context} was cancelled.`), { name: 'AbortError' });
}

/** Checkpoint for work that cannot be interrupted mid-step (Playwright, parsing loops). */
export function throwIfAborted(signal: AbortSignal | undefined, context: string): void {
  if (signal?.aborted) {
    throw abortReason(signal, context);
  }
}

/**
 * `sleep` that loses its race against an abort.
 *
 * The listener is registered `once` and cleared on the timer path — an
 * un-removed listener on a signal that outlives the call (here one signal
 * covers a whole chain fan-out) is the standard leak in this kind of refactor.
 */
export function abortableSleep(ms: number, signal: AbortSignal | undefined, context: string): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortReason(signal, context));

  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal, context));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
