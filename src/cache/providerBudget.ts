/**
 * Daily per-provider request budget tracker.
 *
 * Tracks requests, cache hits, and failures per provider per Europe/Zurich day.
 * Counters are persisted to a JSON state file in the cache directory so
 * restarts do not reset them. Day rollover resets all counters.
 *
 * Default daily budgets (env-overridable):
 * - google: 90 (SWISS_SHOPPING_GOOGLE_DAILY_BUDGET)
 * - serpapi: 8 (SWISS_SHOPPING_SERPAPI_DAILY_BUDGET)
 * - hasdata: 33 (SWISS_SHOPPING_HASDATA_DAILY_BUDGET)
 * - searlo: 33 (SWISS_SHOPPING_SEARLO_DAILY_BUDGET)
 * - firecrawl: 16 (SWISS_SHOPPING_FIRECRAWL_DAILY_BUDGET)
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

const DEFAULT_DAILY_BUDGETS: Record<string, number> = {
  google: 90,
  serpapi: 8,
  hasdata: 33,
  searlo: 33,
  firecrawl: 16,
};

const BUDGET_ENV_VARS: Record<string, string> = {
  google: 'SWISS_SHOPPING_GOOGLE_DAILY_BUDGET',
  serpapi: 'SWISS_SHOPPING_SERPAPI_DAILY_BUDGET',
  hasdata: 'SWISS_SHOPPING_HASDATA_DAILY_BUDGET',
  searlo: 'SWISS_SHOPPING_SEARLO_DAILY_BUDGET',
  firecrawl: 'SWISS_SHOPPING_FIRECRAWL_DAILY_BUDGET',
};

export interface ProviderBudgetOptions {
  cacheDirectory: string;
  /** Default daily budget for Google (env-overridable). Default 90. */
  googleDailyBudget?: number;
  /** Per-provider daily budgets (env overrides take precedence). */
  dailyBudgets?: Record<string, number>;
  /** Custom clock for testing. */
  clock?: { now(): Date };
}

export class ProviderBudget {
  private readonly cacheDirectory: string;
  private readonly dailyBudgets: Record<string, number>;
  private readonly clock: { now(): Date };
  private counters: Record<string, ProviderBudgetCounters> = {};
  private currentDay: string;
  private loaded = false;
  private pendingPersist: Promise<void> = Promise.resolve();

  public constructor(options: ProviderBudgetOptions) {
    this.cacheDirectory = options.cacheDirectory;
    this.clock = options.clock ?? { now: (): Date => new Date() };
    this.currentDay = this.zurichDay(this.clock.now());

    // Merge defaults, constructor overrides, and env overrides
    this.dailyBudgets = { ...DEFAULT_DAILY_BUDGETS };
    if (typeof options.googleDailyBudget === 'number') {
      this.dailyBudgets.google = options.googleDailyBudget;
    }
    if (options.dailyBudgets) {
      Object.assign(this.dailyBudgets, options.dailyBudgets);
    }
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
    const budget = this.dailyBudgets[provider];
    if (typeof budget !== 'number') return false;
    return this.effectiveRequests(provider) >= budget;
  }

  /** Low = within 10% of the budget limit. */
  public isLow(provider: string): boolean {
    const budget = this.dailyBudgets[provider];
    if (typeof budget !== 'number') return false;
    const remaining = budget - this.effectiveRequests(provider);
    return remaining <= Math.ceil(budget * 0.1);
  }

  public getDailyBudget(provider?: string): number {
    if (provider) {
      return this.dailyBudgets[provider] ?? 0;
    }
    return this.dailyBudgets.google ?? 90;
  }

  public getCounters(provider: string): ProviderBudgetCounters {
    this.ensureDay();
    const c = this.counters[provider];
    return c ? { ...c } : { requests: 0, cacheHits: 0, failures: 0 };
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

  const dailyBudgets: Record<string, number> = {};
  for (const [provider, envVar] of Object.entries(BUDGET_ENV_VARS)) {
    const raw = env[envVar];
    if (typeof raw === 'string' && raw.length > 0) {
      const parsed = parseInt(raw, 10);
      if (!Number.isNaN(parsed)) {
        dailyBudgets[provider] = parsed;
      }
    }
  }

  return new ProviderBudget({
    cacheDirectory: dir,
    dailyBudgets: Object.keys(dailyBudgets).length > 0 ? dailyBudgets : undefined,
  });
}
