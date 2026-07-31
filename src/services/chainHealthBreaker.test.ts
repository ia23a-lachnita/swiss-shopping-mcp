import { describe, it, expect } from 'vitest';

import { ChainHealthBreaker } from './chainHealthBreaker.js';

/** Controllable clock so window/cooldown behaviour is tested without real waiting. */
function fakeClock(start = 0): { now(): number; advance(ms: number): void } {
  let t = start;
  return {
    now: (): number => t,
    advance: (ms: number): void => {
      t += ms;
    },
  };
}

describe('ChainHealthBreaker', () => {
  it('allows a chain with no history', () => {
    const breaker = new ChainHealthBreaker();
    expect(breaker.canAttempt('migros')).toBe(true);
    expect(breaker.phase('migros')).toBe('closed');
  });

  it('does not open below the minimum volume, however bad the rate', () => {
    const breaker = new ChainHealthBreaker({ minimumVolume: 5 });
    // 4 straight failures is a 100% failure rate, but too little evidence.
    for (let i = 0; i < 4; i += 1) breaker.record('lidl', false);
    expect(breaker.canAttempt('lidl')).toBe(true);
  });

  it('opens once the failure rate crosses the threshold with enough volume', () => {
    const breaker = new ChainHealthBreaker({ minimumVolume: 5, failureRateThreshold: 0.4 });
    breaker.record('lidl', true);
    breaker.record('lidl', false);
    breaker.record('lidl', false);
    breaker.record('lidl', true);
    breaker.record('lidl', false); // 3/5 = 60% ≥ 40%
    expect(breaker.canAttempt('lidl')).toBe(false);
    expect(breaker.phase('lidl')).toBe('open');
  });

  it('stays closed for a chain that is merely occasionally flaky', () => {
    const breaker = new ChainHealthBreaker({ minimumVolume: 5, failureRateThreshold: 0.4 });
    // 1 failure in 6 = 17%, well under threshold — must not be skipped.
    breaker.record('coop', false);
    for (let i = 0; i < 5; i += 1) breaker.record('coop', true);
    expect(breaker.canAttempt('coop')).toBe(true);
  });

  it('forgets outcomes that age out of the window', () => {
    const clock = fakeClock();
    const breaker = new ChainHealthBreaker({ windowMs: 30_000, minimumVolume: 5, clock });
    for (let i = 0; i < 4; i += 1) breaker.record('lidl', false);
    clock.advance(31_000); // the earlier failures fall out of the window
    breaker.record('lidl', false);
    // Only 1 outcome remains in-window, below minimumVolume.
    expect(breaker.canAttempt('lidl')).toBe(true);
  });

  it('half-opens after the cooldown and closes after enough probe successes', () => {
    const clock = fakeClock();
    const breaker = new ChainHealthBreaker({
      minimumVolume: 3,
      failureRateThreshold: 0.4,
      cooldownMs: 30_000,
      successesToClose: 2,
      clock,
    });
    for (let i = 0; i < 3; i += 1) breaker.record('lidl', false);
    expect(breaker.canAttempt('lidl')).toBe(false);

    clock.advance(15_000);
    expect(breaker.canAttempt('lidl')).toBe(false); // still cooling down

    clock.advance(16_000);
    expect(breaker.canAttempt('lidl')).toBe(true); // probe allowed
    expect(breaker.phase('lidl')).toBe('half-open');

    breaker.record('lidl', true);
    expect(breaker.phase('lidl')).toBe('half-open'); // one success is not enough
    breaker.record('lidl', true);
    expect(breaker.phase('lidl')).toBe('closed');
    expect(breaker.canAttempt('lidl')).toBe(true);
  });

  it('re-opens immediately if the probe fails, and restarts the cooldown', () => {
    const clock = fakeClock();
    const breaker = new ChainHealthBreaker({
      minimumVolume: 3,
      failureRateThreshold: 0.4,
      cooldownMs: 30_000,
      clock,
    });
    for (let i = 0; i < 3; i += 1) breaker.record('lidl', false);
    clock.advance(31_000);
    expect(breaker.canAttempt('lidl')).toBe(true);

    breaker.record('lidl', false); // probe failed
    expect(breaker.canAttempt('lidl')).toBe(false);

    clock.advance(29_000);
    expect(breaker.canAttempt('lidl')).toBe(false); // cooldown restarted, not resumed
    clock.advance(2_000);
    expect(breaker.canAttempt('lidl')).toBe(true);
  });

  it('does not let a single blip re-open a freshly closed chain', () => {
    const clock = fakeClock();
    const breaker = new ChainHealthBreaker({
      minimumVolume: 3,
      failureRateThreshold: 0.4,
      cooldownMs: 30_000,
      successesToClose: 2,
      clock,
    });
    for (let i = 0; i < 3; i += 1) breaker.record('lidl', false);
    clock.advance(31_000);
    breaker.canAttempt('lidl');
    breaker.record('lidl', true);
    breaker.record('lidl', true); // closed, history cleared

    breaker.record('lidl', false);
    expect(breaker.canAttempt('lidl')).toBe(true);
  });

  it('tracks chains independently', () => {
    const breaker = new ChainHealthBreaker({ minimumVolume: 3, failureRateThreshold: 0.4 });
    for (let i = 0; i < 3; i += 1) breaker.record('lidl', false);
    for (let i = 0; i < 3; i += 1) breaker.record('coop', true);
    expect(breaker.canAttempt('lidl')).toBe(false);
    expect(breaker.canAttempt('coop')).toBe(true);
  });
});
