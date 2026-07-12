/**
 * In-memory observability metrics (Phase D).
 *
 * Cheap counters with periodic JSON snapshots to the cache directory
 * so restarts don't zero everything. Exposed via GET /api/metrics and
 * the MCP `get_metrics` tool.
 *
 * Design: all counters are plain numbers — no external metrics library
 * needed. The MetricsCollector is a singleton per process.
 */

import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { logger } from '../util/log.js';

const SNAPSHOT_FILE = 'metrics-snapshot.json';

export interface CacheHitMetrics {
  fresh: number;
  needsRefresh: number;
  staleFallback: number;
  miss: number;
}

export interface WebSearchMetrics {
  /** Total web search invocations. */
  totalSearches: number;
  /** Rolling window of per-query search counts (last 50). */
  perQueryCounts: number[];
  /** Average searches per query (computed on snapshot). */
  avgSearchesPerQuery?: number;
  ddgChallenges: number;
  providerFallbacks: number;
  circuitBreakerOpens: number;
}

export interface HydrationMetrics {
  successes: number;
  failures: number;
  /** Per-chain 404/410 counts. */
  notFoundByChain: Record<string, number>;
}

export interface LatencyMetrics {
  /** Per-chain latency samples (ms). */
  samplesByChain: Record<string, number[]>;
  /** Per-chain average/max latency (computed on snapshot). */
  byChain?: Record<string, { avg: number; max: number }>;
}

export interface CatalogCoverageMetrics {
  productsByChain: Record<string, number>;
  productsByStatus: Record<string, number>;
  totalProducts: number;
  totalObservations: number;
  pendingObservations: number;
}

export interface GoogleQuotaMetrics {
  usedToday: number;
  budgetRemaining: number;
  budgetTotal: number;
}

export interface LatencySnapshot {
  byChain: Record<string, { avg: number; max: number }>;
}

export interface MetricsSnapshot {
  timestamp: string;
  cacheHits: CacheHitMetrics;
  webSearch: WebSearchMetrics;
  hydration: HydrationMetrics;
  latency: LatencySnapshot;
  catalog: CatalogCoverageMetrics;
  googleQuota: GoogleQuotaMetrics;
}

const MAX_LATENCY_SAMPLES = 100;
const MAX_PER_QUERY_SAMPLES = 50;

export class MetricsCollector {
  private readonly cacheHits: CacheHitMetrics = {
    fresh: 0,
    needsRefresh: 0,
    staleFallback: 0,
    miss: 0,
  };

  private readonly webSearch: WebSearchMetrics = {
    totalSearches: 0,
    perQueryCounts: [],
    ddgChallenges: 0,
    providerFallbacks: 0,
    circuitBreakerOpens: 0,
  };

  private readonly hydration: HydrationMetrics = {
    successes: 0,
    failures: 0,
    notFoundByChain: {},
  };

  private readonly latency: LatencyMetrics = {
    samplesByChain: {},
  };

  private readonly catalog: CatalogCoverageMetrics = {
    productsByChain: {},
    productsByStatus: {},
    totalProducts: 0,
    totalObservations: 0,
    pendingObservations: 0,
  };

  private readonly googleQuota: GoogleQuotaMetrics = {
    usedToday: 0,
    budgetRemaining: 90,
    budgetTotal: 90,
  };

  private snapshotTimer: ReturnType<typeof setInterval> | undefined;
  private cacheDirectory?: string;
  private pendingSnapshot: Promise<void> = Promise.resolve();

  public constructor(cacheDirectory?: string) {
    this.cacheDirectory = cacheDirectory;
  }

  // ─── Cache hit tracking ───

  public recordCacheHit(kind: 'fresh' | 'needsRefresh' | 'staleFallback'): void {
    this.cacheHits[kind] += 1;
  }

  public recordCacheMiss(): void {
    this.cacheHits.miss += 1;
  }

  // ─── Web search tracking ───

  public recordWebSearch(): void {
    this.webSearch.totalSearches += 1;
  }

  public recordWebSearchPerQuery(count: number): void {
    this.webSearch.perQueryCounts.push(count);
    if (this.webSearch.perQueryCounts.length > MAX_PER_QUERY_SAMPLES) {
      this.webSearch.perQueryCounts.shift();
    }
  }

  public recordDdgChallenge(): void {
    this.webSearch.ddgChallenges += 1;
  }

  public recordProviderFallback(): void {
    this.webSearch.providerFallbacks += 1;
  }

  public recordCircuitBreakerOpen(): void {
    this.webSearch.circuitBreakerOpens += 1;
  }

  // ─── Hydration tracking ───

  public recordHydrationSuccess(): void {
    this.hydration.successes += 1;
  }

  public recordHydrationFailure(): void {
    this.hydration.failures += 1;
  }

  public recordHydrationNotFound(chain: string): void {
    this.hydration.notFoundByChain[chain] =
      (this.hydration.notFoundByChain[chain] ?? 0) + 1;
  }

  // ─── Latency tracking ───

  public recordLatency(chain: string, ms: number): void {
    if (!this.latency.samplesByChain[chain]) {
      this.latency.samplesByChain[chain] = [];
    }
    const samples = this.latency.samplesByChain[chain];
    samples.push(ms);
    if (samples.length > MAX_LATENCY_SAMPLES) {
      samples.shift();
    }
  }

  // ─── Catalog coverage (snapshot from CatalogService.stats()) ───

  public updateCatalogCoverage(stats: {
    totalProducts: number;
    productsByStatus: Record<string, number>;
    productsByChain: Record<string, number>;
    totalObservations: number;
    pendingObservations?: number;
  }): void {
    this.catalog.totalProducts = stats.totalProducts;
    this.catalog.productsByStatus = { ...stats.productsByStatus };
    this.catalog.productsByChain = { ...stats.productsByChain };
    this.catalog.totalObservations = stats.totalObservations;
    if (typeof stats.pendingObservations === 'number') {
      this.catalog.pendingObservations = stats.pendingObservations;
    }
  }

  // ─── Google quota ───

  public updateGoogleQuota(used: number, budget: number): void {
    this.googleQuota.usedToday = used;
    this.googleQuota.budgetTotal = budget;
    this.googleQuota.budgetRemaining = Math.max(0, budget - used);
  }

  // ─── Snapshot ───

  public snapshot(): MetricsSnapshot {
    const avgWebSearchesPerQuery =
      this.webSearch.perQueryCounts.length > 0
        ? this.webSearch.perQueryCounts.reduce((a, b) => a + b, 0) /
          this.webSearch.perQueryCounts.length
        : 0;

    const avgLatencyByChain: Record<string, { avg: number; max: number }> = {};
    for (const [chain, samples] of Object.entries(this.latency.samplesByChain)) {
      if (samples.length === 0) continue;
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
      const max = Math.max(...samples);
      avgLatencyByChain[chain] = { avg: Math.round(avg), max };
    }

    const latencySnapshot: LatencySnapshot = { byChain: avgLatencyByChain };

    return {
      timestamp: new Date().toISOString(),
      cacheHits: { ...this.cacheHits },
      webSearch: {
        totalSearches: this.webSearch.totalSearches,
        perQueryCounts: [...this.webSearch.perQueryCounts],
        avgSearchesPerQuery: Math.round(avgWebSearchesPerQuery * 100) / 100,
        ddgChallenges: this.webSearch.ddgChallenges,
        providerFallbacks: this.webSearch.providerFallbacks,
        circuitBreakerOpens: this.webSearch.circuitBreakerOpens,
      },
      hydration: {
        successes: this.hydration.successes,
        failures: this.hydration.failures,
        notFoundByChain: { ...this.hydration.notFoundByChain },
      },
      latency: latencySnapshot,
      catalog: { ...this.catalog },
      googleQuota: { ...this.googleQuota },
    };
  }

  // ─── Persistence ───

  public startPeriodicSnapshot(intervalMs = 5 * 60 * 1_000): void {
    this.snapshotTimer = setInterval(() => {
      this.persistSnapshot().catch((err) => {
        logger.debug('Metrics snapshot persist failed', err);
      });
    }, intervalMs);
    this.snapshotTimer.unref();
  }

  public stopPeriodicSnapshot(): void {
    if (this.snapshotTimer !== undefined) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = undefined;
    }
  }

  public async persistSnapshot(): Promise<void> {
    if (!this.cacheDirectory) return;
    const snapshot = this.snapshot();
    this.pendingSnapshot = (async (): Promise<void> => {
      try {
        await mkdir(this.cacheDirectory!, { recursive: true });
        await writeFile(
          join(this.cacheDirectory!, SNAPSHOT_FILE),
          JSON.stringify(snapshot),
          'utf8'
        );
      } catch (err) {
        logger.debug('Metrics: failed to persist snapshot', err);
      }
    })();
    return this.pendingSnapshot;
  }

  public async loadSnapshot(): Promise<void> {
    if (!this.cacheDirectory) return;
    try {
      const raw = await readFile(
        join(this.cacheDirectory, SNAPSHOT_FILE),
        'utf8'
      );
      const snapshot = JSON.parse(raw) as MetricsSnapshot;
      // Restore counters from snapshot (best-effort)
      if (snapshot.cacheHits) {
        this.cacheHits.fresh = snapshot.cacheHits.fresh ?? 0;
        this.cacheHits.needsRefresh = snapshot.cacheHits.needsRefresh ?? 0;
        this.cacheHits.staleFallback = snapshot.cacheHits.staleFallback ?? 0;
        this.cacheHits.miss = snapshot.cacheHits.miss ?? 0;
      }
      if (snapshot.webSearch) {
        this.webSearch.totalSearches = snapshot.webSearch.totalSearches ?? 0;
        this.webSearch.ddgChallenges = snapshot.webSearch.ddgChallenges ?? 0;
        this.webSearch.providerFallbacks = snapshot.webSearch.providerFallbacks ?? 0;
        this.webSearch.circuitBreakerOpens = snapshot.webSearch.circuitBreakerOpens ?? 0;
      }
      if (snapshot.hydration) {
        this.hydration.successes = snapshot.hydration.successes ?? 0;
        this.hydration.failures = snapshot.hydration.failures ?? 0;
        this.hydration.notFoundByChain = snapshot.hydration.notFoundByChain ?? {};
      }
      if (snapshot.catalog) {
        this.catalog.totalProducts = snapshot.catalog.totalProducts ?? 0;
        this.catalog.productsByChain = snapshot.catalog.productsByChain ?? {};
        this.catalog.productsByStatus = snapshot.catalog.productsByStatus ?? {};
        this.catalog.totalObservations = snapshot.catalog.totalObservations ?? 0;
        this.catalog.pendingObservations = snapshot.catalog.pendingObservations ?? 0;
      }
      if (snapshot.googleQuota) {
        this.googleQuota.usedToday = snapshot.googleQuota.usedToday ?? 0;
        this.googleQuota.budgetRemaining = snapshot.googleQuota.budgetRemaining ?? 90;
        this.googleQuota.budgetTotal = snapshot.googleQuota.budgetTotal ?? 90;
      }
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        return; // First run — no snapshot yet
      }
      logger.debug('Metrics: failed to load snapshot', err);
    }
  }

  /** Wait for any in-flight persist to complete. Useful in tests. */
  public async flush(): Promise<void> {
    await this.pendingSnapshot;
  }

  // ─── Reset (for tests) ───

  public reset(): void {
    this.cacheHits.fresh = 0;
    this.cacheHits.needsRefresh = 0;
    this.cacheHits.staleFallback = 0;
    this.cacheHits.miss = 0;
    this.webSearch.totalSearches = 0;
    this.webSearch.perQueryCounts = [];
    this.webSearch.ddgChallenges = 0;
    this.webSearch.providerFallbacks = 0;
    this.webSearch.circuitBreakerOpens = 0;
    this.hydration.successes = 0;
    this.hydration.failures = 0;
    this.hydration.notFoundByChain = {};
    this.latency.samplesByChain = {};
    this.catalog.productsByChain = {};
    this.catalog.productsByStatus = {};
    this.catalog.totalProducts = 0;
    this.catalog.totalObservations = 0;
    this.catalog.pendingObservations = 0;
    this.googleQuota.usedToday = 0;
    this.googleQuota.budgetRemaining = 90;
    this.googleQuota.budgetTotal = 90;
  }
}

/**
 * Default singleton metrics collector.
 * Wired into the server at startup.
 */
let defaultCollector: MetricsCollector | undefined;

export function getMetricsCollector(cacheDirectory?: string): MetricsCollector {
  if (!defaultCollector) {
    defaultCollector = new MetricsCollector(cacheDirectory);
  }
  return defaultCollector;
}

export function resetMetricsCollector(): void {
  defaultCollector = undefined;
}
