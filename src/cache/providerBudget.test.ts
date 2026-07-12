import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { ProviderBudget } from './providerBudget.js';

const budgetDirs: string[] = [];

function fakeClock(initial: Date): { now(): Date; advanceMs(ms: number): void } {
  let current = initial.getTime();
  return {
    now: (): Date => new Date(current),
    advanceMs: (ms: number): void => { current += ms; },
  };
}

async function createBudget(
  clock: { now(): Date },
  googleDailyBudget = 90,
): Promise<{ budget: ProviderBudget; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'swiss-shopping-budget-'));
  budgetDirs.push(directory);
  const budget = new ProviderBudget({
    cacheDirectory: directory,
    googleDailyBudget,
    clock,
  });
  await budget.load();
  return { budget, directory };
}

describe('ProviderBudget', () => {
  afterEach(async () => {
    await Promise.all(budgetDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('tracks requests per provider', async () => {
    const clock = fakeClock(new Date('2026-06-15T10:00:00.000Z'));
    const { budget } = await createBudget(clock);

    budget.recordRequest('google');
    budget.recordRequest('google');
    budget.recordRequest('ddg');

    expect(budget.effectiveRequests('google')).toBe(2);
    expect(budget.effectiveRequests('ddg')).toBe(1);
    expect(budget.getCounters('google')).toEqual({ requests: 2, cacheHits: 0, failures: 0 });
  });

  it('subtract cache hits from effective requests', async () => {
    const clock = fakeClock(new Date('2026-06-15T10:00:00.000Z'));
    const { budget } = await createBudget(clock);

    budget.recordRequest('google');
    budget.recordRequest('google');
    budget.recordRequest('google');
    budget.recordCacheHit('google');

    expect(budget.effectiveRequests('google')).toBe(2);
  });

  it('isExhausted returns true when effective requests >= budget', async () => {
    const clock = fakeClock(new Date('2026-06-15T10:00:00.000Z'));
    const { budget } = await createBudget(clock, 5);

    for (let i = 0; i < 5; i++) {
      budget.recordRequest('google');
    }

    expect(budget.isExhausted('google')).toBe(true);
    expect(budget.isExhausted('ddg')).toBe(false); // Only google has budget
  });

  it('isLow returns true when within 10% of budget', async () => {
    const clock = fakeClock(new Date('2026-06-15T10:00:00.000Z'));
    const { budget } = await createBudget(clock, 100);

    // 91 requests = 9 remaining (9% of 100)
    for (let i = 0; i < 91; i++) {
      budget.recordRequest('google');
    }

    expect(budget.isLow('google')).toBe(true);
    expect(budget.isExhausted('google')).toBe(false);
  });

  it('counters persist across service instances (same cache dir)', async () => {
    const clock = fakeClock(new Date('2026-06-15T10:00:00.000Z'));
    const { budget: budget1, directory } = await createBudget(clock);

    budget1.recordRequest('google');
    budget1.recordRequest('google');
    budget1.recordFailure('google');

    // Ensure the persist completes before creating a new instance
    await budget1.flush();

    // Create a new instance reading from the same directory
    const budget2 = new ProviderBudget({
      cacheDirectory: directory,
      googleDailyBudget: 90,
      clock,
    });
    await budget2.load();

    expect(budget2.getCounters('google')).toEqual({ requests: 2, cacheHits: 0, failures: 1 });
    expect(budget2.effectiveRequests('google')).toBe(2);
  });

  it('day rollover resets counters', async () => {
    const clock = fakeClock(new Date('2026-06-15T10:00:00.000Z'));
    const { budget, directory } = await createBudget(clock, 90);

    budget.recordRequest('google');
    budget.recordRequest('google');
    expect(budget.effectiveRequests('google')).toBe(2);

    // Advance to next day
    clock.advanceMs(24 * 60 * 60 * 1_000);
    const budget2 = new ProviderBudget({
      cacheDirectory: directory,
      googleDailyBudget: 90,
      clock,
    });
    await budget2.load();

    expect(budget2.effectiveRequests('google')).toBe(0);
    expect(budget2.isExhausted('google')).toBe(false);
  });

  it('getDailyBudget returns the configured budget', async () => {
    const clock = fakeClock(new Date('2026-06-15T10:00:00.000Z'));
    const { budget } = await createBudget(clock, 42);

    expect(budget.getDailyBudget()).toBe(42);
  });

  it('recordFailure tracks failures', async () => {
    const clock = fakeClock(new Date('2026-06-15T10:00:00.000Z'));
    const { budget } = await createBudget(clock);

    budget.recordFailure('google');
    budget.recordFailure('google');

    expect(budget.getCounters('google')).toEqual({ requests: 0, cacheHits: 0, failures: 2 });
  });
});
