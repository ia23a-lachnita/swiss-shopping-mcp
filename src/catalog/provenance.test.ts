import { describe, it, expect } from 'vitest';
import { computeConfidence } from './provenance.js';

describe('computeConfidence', () => {
  it('should return 1.0 for fresh vendor hydration', () => {
    const confidence = computeConfidence({
      discoveredBy: 'vendor',
      stale: false,
      cacheFresh: false,
      cacheNeedsRefresh: false,
    });
    expect(confidence).toBe(1.0);
  });

  it('should return 0.9 for fresh cache hit', () => {
    const confidence = computeConfidence({
      discoveredBy: 'vendor',
      stale: false,
      cacheFresh: true,
      cacheNeedsRefresh: false,
    });
    expect(confidence).toBe(0.9);
  });

  it('should return 0.7 for needs-refresh cache', () => {
    const confidence = computeConfidence({
      discoveredBy: 'vendor',
      stale: false,
      cacheFresh: false,
      cacheNeedsRefresh: true,
    });
    expect(confidence).toBe(0.7);
  });

  it('should return 0.5 for stale fallback', () => {
    const confidence = computeConfidence({
      discoveredBy: 'vendor',
      stale: true,
      cacheFresh: false,
      cacheNeedsRefresh: false,
    });
    expect(confidence).toBe(0.5);
  });

  it('should return 0.3 for catalog-only result', () => {
    const confidence = computeConfidence({
      discoveredBy: 'catalog',
      stale: false,
      cacheFresh: false,
      cacheNeedsRefresh: false,
    });
    expect(confidence).toBe(0.3);
  });

  it('should return 0.2 for web-discovered result', () => {
    const googleConfidence = computeConfidence({
      discoveredBy: 'web-google',
      stale: false,
      cacheFresh: false,
      cacheNeedsRefresh: false,
    });
    expect(googleConfidence).toBe(0.2);

    const ddgConfidence = computeConfidence({
      discoveredBy: 'web-ddg',
      stale: false,
      cacheFresh: false,
      cacheNeedsRefresh: false,
    });
    expect(ddgConfidence).toBe(0.2);
  });

  it('should order: fresh > stale > catalog-only', () => {
    const fresh = computeConfidence({
      discoveredBy: 'vendor',
      stale: false,
    });
    const stale = computeConfidence({
      discoveredBy: 'vendor',
      stale: true,
    });
    const catalogOnly = computeConfidence({
      discoveredBy: 'catalog',
      stale: false,
    });

    expect(fresh).toBeGreaterThan(stale);
    expect(stale).toBeGreaterThan(catalogOnly);
  });
});
