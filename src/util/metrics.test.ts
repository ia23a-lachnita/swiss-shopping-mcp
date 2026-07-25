import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetricsCollector } from './metrics.js';

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  describe('cache hit tracking', () => {
    it('should increment fresh hits', () => {
      collector.recordCacheHit('fresh');
      collector.recordCacheHit('fresh');
      const snapshot = collector.snapshot();
      expect(snapshot.cacheHits.fresh).toBe(2);
      expect(snapshot.cacheHits.miss).toBe(0);
    });

    it('should increment needsRefresh hits', () => {
      collector.recordCacheHit('needsRefresh');
      const snapshot = collector.snapshot();
      expect(snapshot.cacheHits.needsRefresh).toBe(1);
    });

    it('should increment staleFallback hits', () => {
      collector.recordCacheHit('staleFallback');
      const snapshot = collector.snapshot();
      expect(snapshot.cacheHits.staleFallback).toBe(1);
    });

    it('should increment misses', () => {
      collector.recordCacheMiss();
      collector.recordCacheMiss();
      const snapshot = collector.snapshot();
      expect(snapshot.cacheHits.miss).toBe(2);
    });
  });

  describe('web search tracking', () => {
    it('should track total searches', () => {
      collector.recordWebSearch();
      collector.recordWebSearch();
      collector.recordWebSearch();
      const snapshot = collector.snapshot();
      expect(snapshot.webSearch.totalSearches).toBe(3);
    });

    it('should compute avgSearchesPerQuery', () => {
      collector.recordWebSearchPerQuery(3);
      collector.recordWebSearchPerQuery(5);
      const snapshot = collector.snapshot();
      expect(snapshot.webSearch.avgSearchesPerQuery).toBe(4);
    });

    it('should track DDG challenges', () => {
      collector.recordDdgChallenge();
      collector.recordDdgChallenge();
      const snapshot = collector.snapshot();
      expect(snapshot.webSearch.ddgChallenges).toBe(2);
    });

    it('should track provider fallbacks', () => {
      collector.recordProviderFallback();
      const snapshot = collector.snapshot();
      expect(snapshot.webSearch.providerFallbacks).toBe(1);
    });

    it('should track circuit breaker opens', () => {
      collector.recordCircuitBreakerOpen();
      const snapshot = collector.snapshot();
      expect(snapshot.webSearch.circuitBreakerOpens).toBe(1);
    });
  });

  describe('hydration tracking', () => {
    it('should track successes and failures', () => {
      collector.recordHydrationSuccess();
      collector.recordHydrationSuccess();
      collector.recordHydrationFailure();
      const snapshot = collector.snapshot();
      expect(snapshot.hydration.successes).toBe(2);
      expect(snapshot.hydration.failures).toBe(1);
    });

    it('should track not-found by chain', () => {
      collector.recordHydrationNotFound('migros');
      collector.recordHydrationNotFound('migros');
      collector.recordHydrationNotFound('coop');
      const snapshot = collector.snapshot();
      expect(snapshot.hydration.notFoundByChain['migros']).toBe(2);
      expect(snapshot.hydration.notFoundByChain['coop']).toBe(1);
    });
  });

  describe('latency tracking', () => {
    it('should compute avg and max per chain', () => {
      collector.recordLatency('migros', 100);
      collector.recordLatency('migros', 200);
      collector.recordLatency('migros', 150);
      const snapshot = collector.snapshot();
      expect(snapshot.latency.byChain['migros']).toEqual({ avg: 150, max: 200 });
    });

    it('should handle empty samples', () => {
      const snapshot = collector.snapshot();
      expect(snapshot.latency.byChain).toEqual({});
    });
  });

  describe('catalog coverage', () => {
    it('should update from stats', () => {
      collector.updateCatalogCoverage({
        totalProducts: 100,
        productsByStatus: { active: 90, suspected_removed: 5, removed: 5 },
        productsByChain: { migros: 50, coop: 50 },
        totalObservations: 500,
        pendingObservations: 3,
      });
      const snapshot = collector.snapshot();
      expect(snapshot.catalog.totalProducts).toBe(100);
      expect(snapshot.catalog.productsByChain['migros']).toBe(50);
      expect(snapshot.catalog.totalObservations).toBe(500);
      expect(snapshot.catalog.pendingObservations).toBe(3);
    });
  });

  describe('Google quota', () => {
    it('should update quota', () => {
      collector.updateGoogleQuota(42, 90);
      const snapshot = collector.snapshot();
      expect(snapshot.googleQuota.usedToday).toBe(42);
      expect(snapshot.googleQuota.budgetRemaining).toBe(48);
      expect(snapshot.googleQuota.budgetTotal).toBe(90);
    });

    it('should clamp remaining to zero', () => {
      collector.updateGoogleQuota(100, 90);
      const snapshot = collector.snapshot();
      expect(snapshot.googleQuota.budgetRemaining).toBe(0);
    });
  });

  describe('snapshot format', () => {
    it('should include timestamp', () => {
      const snapshot = collector.snapshot();
      expect(snapshot.timestamp).toBeDefined();
      expect(typeof snapshot.timestamp).toBe('string');
      // Should be a valid ISO date
      expect(Number.isFinite(Date.parse(snapshot.timestamp))).toBe(true);
    });
  });

  describe('reset', () => {
    it('should zero all counters', () => {
      collector.recordCacheHit('fresh');
      collector.recordWebSearch();
      collector.recordHydrationSuccess();
      collector.recordLatency('migros', 100);
      collector.updateCatalogCoverage({
        totalProducts: 10,
        productsByStatus: { active: 10, suspected_removed: 0, removed: 0 },
        productsByChain: { migros: 10 },
        totalObservations: 5,
      });

      collector.reset();

      const snapshot = collector.snapshot();
      expect(snapshot.cacheHits.fresh).toBe(0);
      expect(snapshot.webSearch.totalSearches).toBe(0);
      expect(snapshot.hydration.successes).toBe(0);
      expect(snapshot.catalog.totalProducts).toBe(0);
    });
  });
});

describe('MetricsCollector persistence', () => {
  const testDir = join(tmpdir(), 'swiss-shopping-mcp-test-metrics');

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should persist and reload snapshot', async () => {
    await mkdir(testDir, { recursive: true });

    const collector = new MetricsCollector(testDir);
    collector.recordCacheHit('fresh');
    collector.recordCacheHit('fresh');
    collector.recordWebSearch();
    collector.recordHydrationSuccess();

    await collector.persistSnapshot();

    // Verify file exists
    const content = await readFile(join(testDir, 'metrics-snapshot.json'), 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.cacheHits.fresh).toBe(2);
    expect(parsed.webSearch.totalSearches).toBe(1);

    // Load into a new collector
    const collector2 = new MetricsCollector(testDir);
    await collector2.loadSnapshot();

    const snapshot = collector2.snapshot();
    expect(snapshot.cacheHits.fresh).toBe(2);
    expect(snapshot.webSearch.totalSearches).toBe(1);
    expect(snapshot.hydration.successes).toBe(1);
  });

  it('should persist and restore raw latency samples across restarts', async () => {
    await mkdir(testDir, { recursive: true });

    const collector = new MetricsCollector(testDir);
    collector.recordLatency('migros', 100);
    collector.recordLatency('migros', 200);
    collector.recordLatency('coop', 50);

    await collector.persistSnapshot();

    const collector2 = new MetricsCollector(testDir);
    await collector2.loadSnapshot();

    const snapshot = collector2.snapshot();
    expect(snapshot.latency.byChain.migros).toEqual({ avg: 150, max: 200 });
    expect(snapshot.latency.byChain.coop).toEqual({ avg: 50, max: 50 });
  });

  it('should handle missing snapshot file gracefully', async () => {
    await mkdir(testDir, { recursive: true });
    const collector = new MetricsCollector(testDir);
    // Should not throw
    await collector.loadSnapshot();
    const snapshot = collector.snapshot();
    expect(snapshot.cacheHits.fresh).toBe(0);
  });
});
