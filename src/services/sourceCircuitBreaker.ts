export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  clock?: { now(): Date };
}

interface BreakerState {
  failures: number;
  openedAt?: number;
}

export class SourceCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly clock: { now(): Date };
  private readonly state = new Map<string, BreakerState>();

  public constructor(options: CircuitBreakerOptions) {
    this.failureThreshold = options.failureThreshold;
    this.cooldownMs = options.cooldownMs;
    this.clock = options.clock ?? { now: (): Date => new Date() };
  }

  public canAttempt(key: string): boolean {
    const entry = this.state.get(key);
    if (!entry || entry.openedAt === undefined) {
      return true;
    }

    const elapsed = this.clock.now().getTime() - entry.openedAt;
    if (elapsed >= this.cooldownMs) {
      entry.openedAt = undefined;
      entry.failures = 0;
      return true;
    }

    return false;
  }

  public recordSuccess(key: string): void {
    this.state.delete(key);
  }

  public recordFailure(key: string): void {
    const entry = this.state.get(key) ?? { failures: 0 };
    entry.failures += 1;

    if (entry.failures >= this.failureThreshold && entry.openedAt === undefined) {
      entry.openedAt = this.clock.now().getTime();
    }

    this.state.set(key, entry);
  }

  public isOpen(key: string): boolean {
    return !this.canAttempt(key);
  }
}
