import { describe, expect, it } from 'vitest';

import { SourceCircuitBreaker } from './sourceCircuitBreaker.js';

function fakeClock(initial: Date): { now(): Date; advanceMs(ms: number): void } {
  let current = initial.getTime();
  return {
    now: (): Date => new Date(current),
    advanceMs: (ms: number): void => {
      current += ms;
    },
  };
}

describe('SourceCircuitBreaker', () => {
  it('allows attempts when no failures recorded', () => {
    const breaker = new SourceCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
    expect(breaker.canAttempt('aldi:productSearch')).toBe(true);
  });

  it('opens after reaching failure threshold', () => {
    const breaker = new SourceCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });

    breaker.recordFailure('aldi:productSearch');
    breaker.recordFailure('aldi:productSearch');
    expect(breaker.canAttempt('aldi:productSearch')).toBe(true);

    breaker.recordFailure('aldi:productSearch');
    expect(breaker.canAttempt('aldi:productSearch')).toBe(false);
    expect(breaker.isOpen('aldi:productSearch')).toBe(true);
  });

  it('opens after repeated failures and fails fast until cooldown expires', () => {
    const clock = fakeClock(new Date('2026-06-15T10:00:00.000Z'));
    const breaker = new SourceCircuitBreaker({ failureThreshold: 5, cooldownMs: 60_000, clock });

    for (let index = 0; index < 5; index += 1) {
      breaker.recordFailure('pepesto:productSearch');
    }

    expect(breaker.canAttempt('pepesto:productSearch')).toBe(false);

    clock.advanceMs(60_001);
    expect(breaker.canAttempt('pepesto:productSearch')).toBe(true);
  });

  it('resets on success before threshold', () => {
    const breaker = new SourceCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });

    breaker.recordFailure('denner:promotions');
    breaker.recordFailure('denner:promotions');
    breaker.recordSuccess('denner:promotions');

    expect(breaker.canAttempt('denner:promotions')).toBe(true);
  });

  it('tracks different keys independently', () => {
    const breaker = new SourceCircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 });

    breaker.recordFailure('aldi:productSearch');
    breaker.recordFailure('aldi:productSearch');

    expect(breaker.canAttempt('aldi:productSearch')).toBe(false);
    expect(breaker.canAttempt('denner:promotions')).toBe(true);
  });

  it('allows retry after cooldown and resets failure count', () => {
    const clock = fakeClock(new Date('2026-06-15T10:00:00.000Z'));
    const breaker = new SourceCircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000, clock });

    breaker.recordFailure('migros:productSearch');
    breaker.recordFailure('migros:productSearch');
    expect(breaker.canAttempt('migros:productSearch')).toBe(false);

    clock.advanceMs(1_001);
    expect(breaker.canAttempt('migros:productSearch')).toBe(true);

    breaker.recordFailure('migros:productSearch');
    expect(breaker.canAttempt('migros:productSearch')).toBe(true);
  });
});
