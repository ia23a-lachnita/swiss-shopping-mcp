/**
 * Rolling-window circuit breaker for the product-search chain fan-out.
 *
 * Deliberately separate from `SourceCircuitBreaker`, which trips on *consecutive*
 * failures and is load-bearing for the web-search provider chain. Chains are
 * different: they fail intermittently rather than cleanly, so a consecutive
 * counter almost never trips on a chain that is failing 60% of the time — which
 * is exactly the chain that should be skipped.
 *
 * The point is latency, not correctness. A chain that is reliably dead costs its
 * full soft-timeout budget on *every* search, warm cache or not, which is what
 * made caching look broken to the user. Skipping it costs 0ms.
 *
 * Defaults follow the anti-flapping config agreed in the fix plan: a minimum
 * request volume before any decision, a failure *rate* over a short window, a
 * cooldown before probing again, and more than one success required to close.
 */
export interface ChainHealthBreakerOptions {
  /** Sliding window over which the failure rate is measured. */
  windowMs?: number;
  /** Minimum outcomes in the window before the breaker will open at all. */
  minimumVolume?: number;
  /** Failure rate (0-1) at or above which the breaker opens. */
  failureRateThreshold?: number;
  /** How long to stay open before allowing a probe. */
  cooldownMs?: number;
  /** Consecutive probe successes required to close again. */
  successesToClose?: number;
  clock?: { now(): number };
}

type BreakerPhase = 'closed' | 'open' | 'half-open';

interface Outcome {
  at: number;
  ok: boolean;
}

interface ChainState {
  outcomes: Outcome[];
  phase: BreakerPhase;
  openedAt?: number;
  probeSuccesses: number;
}

export class ChainHealthBreaker {
  private readonly windowMs: number;
  private readonly minimumVolume: number;
  private readonly failureRateThreshold: number;
  private readonly cooldownMs: number;
  private readonly successesToClose: number;
  private readonly clock: { now(): number };
  private readonly state = new Map<string, ChainState>();

  public constructor(options: ChainHealthBreakerOptions = {}) {
    this.windowMs = options.windowMs ?? 30_000;
    this.minimumVolume = options.minimumVolume ?? 5;
    this.failureRateThreshold = options.failureRateThreshold ?? 0.4;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.successesToClose = options.successesToClose ?? 2;
    this.clock = options.clock ?? { now: (): number => Date.now() };
  }

  /** True if `chain` should be called. Transitions open → half-open once the cooldown is up. */
  public canAttempt(chain: string): boolean {
    const entry = this.state.get(chain);
    if (!entry || entry.phase === 'closed') return true;

    if (entry.phase === 'half-open') return true;

    const openFor = this.clock.now() - (entry.openedAt ?? 0);
    if (openFor >= this.cooldownMs) {
      entry.phase = 'half-open';
      entry.probeSuccesses = 0;
      return true;
    }
    return false;
  }

  public isOpen(chain: string): boolean {
    return !this.canAttempt(chain);
  }

  public phase(chain: string): BreakerPhase {
    return this.state.get(chain)?.phase ?? 'closed';
  }

  /** Feed a call outcome back in. Drives every state transition. */
  public record(chain: string, ok: boolean): void {
    const now = this.clock.now();
    const entry = this.state.get(chain) ?? {
      outcomes: [],
      phase: 'closed' as BreakerPhase,
      probeSuccesses: 0,
    };

    entry.outcomes.push({ at: now, ok });
    entry.outcomes = entry.outcomes.filter((o) => now - o.at < this.windowMs);

    if (entry.phase === 'half-open') {
      if (ok) {
        entry.probeSuccesses += 1;
        if (entry.probeSuccesses >= this.successesToClose) {
          // Fully recovered: drop the history too, so the failures that opened
          // the breaker can't immediately re-open it on the next single blip.
          this.state.delete(chain);
          return;
        }
      } else {
        entry.phase = 'open';
        entry.openedAt = now;
        entry.probeSuccesses = 0;
      }
      this.state.set(chain, entry);
      return;
    }

    if (entry.phase === 'closed' && entry.outcomes.length >= this.minimumVolume) {
      const failures = entry.outcomes.filter((o) => !o.ok).length;
      if (failures / entry.outcomes.length >= this.failureRateThreshold) {
        entry.phase = 'open';
        entry.openedAt = now;
        entry.probeSuccesses = 0;
      }
    }

    this.state.set(chain, entry);
  }

  /** Test/diagnostic hook. */
  public reset(): void {
    this.state.clear();
  }
}
