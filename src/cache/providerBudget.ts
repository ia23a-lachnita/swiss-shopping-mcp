/**
 * Daily per-provider request budget tracker.
 *
 * Tracks requests, cache hits, and failures per provider per Europe/Zurich day.
 * Counters are persisted to a JSON state file in the cache directory so
 * restarts do not reset them. Day rollover resets all counters.
 *
 * Google CSE free tier is 100 queries/day; default daily budget is 90
 * (env-overridable via SWISS_SHOPPING_GOOGLE_DAILY_BUDGET).
 */

import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { logger } from '../util/log.js';

const STATE_FILE = 'provider-budget.json';

export interface ProviderBudgetCounters {
  requests: number;
  cacheHits: number;
  failures: number;
}

interface PersistedState {
  /** ISO date string of the day these counters belong to (Europe/Zurich). */
  day: string;
  counters: Record<string, ProviderBudgetCounters>;
}

export interface ProviderBudgetOptions {
  cacheDirectory: string;
  /** Default daily budget for Google (env-overridable). Default 90. */
  googleDailyBudget?: number;
  /** Custom clock for testing. */
  clock?: { now(): Date };
}

export class ProviderBudget {
  private readonly cacheDirectory: string;
  private readonly googleDailyBudget: number;
  private readonly clock: { now(): Date };
  private counters: Record<string, ProviderBudgetCounters> = {};
  private currentDay: string;
  private loaded = false;
  private pendingPersist: Promise<void> = Promise.resolve();

  public constructor(options: ProviderBudgetOptions) {
    this.cacheDirectory = options.cacheDirectory;
    this.googleDailyBudget = options.googleDailyBudget ?? 90;
    this.clock = options.clock ?? { now: (): Date => new Date() };
    this.currentDay = this.zurichDay(this.clock.now());
  }

  /** Get the Europe/Zurich calendar day as YYYY-MM-DD. */
  private zurichDay(date: Date): string {
    return date.toLocaleDateString('en-CA', { timeZone: 'Europe/Zurich' });
  }

  private ensureDay(): void {
    const today = this.zurichDay(this.clock.now());
    if (today !== this.currentDay) {
      this.currentDay = today;
      this.counters = {};
    }
  }

  public async load(): Promise<void> {
    if (this.loaded) return;
    try {
      await mkdir(this.cacheDirectory, { recursive: true });
      const raw = await readFile(this.filePath(), 'utf8');
      const state = JSON.parse(raw) as PersistedState;
      if (state.day === this.currentDay && state.counters) {
        this.counters = state.counters;
      }
      // If day doesn't match, counters stay empty (new day).
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        // First run — no state file yet.
        return;
      }
      logger.debug('ProviderBudget: failed to load state', error);
    } finally {
      this.loaded = true;
    }
  }

  public async persist(): Promise<void> {
    this.ensureDay();
    const state: PersistedState = {
      day: this.currentDay,
      counters: this.counters,
    };
    try {
      await mkdir(this.cacheDirectory, { recursive: true });
      await writeFile(this.filePath(), JSON.stringify(state), 'utf8');
    } catch (error) {
      logger.debug('ProviderBudget: failed to persist state', error);
    }
  }

  /** Wait for any in-flight persist to complete. Useful in tests. */
  public async flush(): Promise<void> {
    await this.pendingPersist;
  }

  public recordRequest(provider: string): void {
    this.ensureDay();
    const c = this.getOrCreate(provider);
    c.requests += 1;
    this.pendingPersist = this.persist();
  }

  public recordCacheHit(provider: string): void {
    this.ensureDay();
    const c = this.getOrCreate(provider);
    c.cacheHits += 1;
    this.pendingPersist = this.persist();
  }

  public recordFailure(provider: string): void {
    this.ensureDay();
    const c = this.getOrCreate(provider);
    c.failures += 1;
    this.pendingPersist = this.persist();
  }

  /** Effective requests = requests minus cache hits (actual engine calls). */
  public effectiveRequests(provider: string): number {
    this.ensureDay();
    const c = this.counters[provider];
    if (!c) return 0;
    return Math.max(0, c.requests - c.cacheHits);
  }

  public isExhausted(provider: string): boolean {
    if (provider !== 'google') return false;
    return this.effectiveRequests('google') >= this.googleDailyBudget;
  }

  /** Low = within 10% of the budget limit. */
  public isLow(provider: string): boolean {
    if (provider !== 'google') return false;
    const remaining = this.googleDailyBudget - this.effectiveRequests('google');
    return remaining <= Math.ceil(this.googleDailyBudget * 0.1);
  }

  public getCounters(provider: string): ProviderBudgetCounters {
    this.ensureDay();
    const c = this.counters[provider];
    return c ? { ...c } : { requests: 0, cacheHits: 0, failures: 0 };
  }

  public getDailyBudget(): number {
    return this.googleDailyBudget;
  }

  private getOrCreate(provider: string): ProviderBudgetCounters {
    if (!this.counters[provider]) {
      this.counters[provider] = { requests: 0, cacheHits: 0, failures: 0 };
    }
    return this.counters[provider];
  }

  private filePath(): string {
    return join(this.cacheDirectory, STATE_FILE);
  }
}

export function createProviderBudgetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  cacheDirectory?: string,
): ProviderBudget | undefined {
  const dir =
    cacheDirectory ??
    env.SWISS_SHOPPING_CACHE_DIR ??
    join('/tmp', 'swiss-shopping-mcp-cache');

  const budgetRaw = env.SWISS_SHOPPING_GOOGLE_DAILY_BUDGET;
  const budget = typeof budgetRaw === 'string' && budgetRaw.length > 0
    ? parseInt(budgetRaw, 10)
    : undefined;

  return new ProviderBudget({
    cacheDirectory: dir,
    ...(typeof budget === 'number' && !Number.isNaN(budget) ? { googleDailyBudget: budget } : {}),
  });
}
