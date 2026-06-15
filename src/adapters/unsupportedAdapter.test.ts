import { describe, expect, it } from 'vitest';

import { SourceWarningCode } from './types.js';
import { UnsupportedChainAdapter } from './unsupportedAdapter.js';

describe('UnsupportedChainAdapter', () => {
  it('returns REAL_SOURCE_NOT_IMPLEMENTED for product search', async () => {
    const adapter = new UnsupportedChainAdapter('coop', {
      productSearch: 'No approved Coop product source is implemented.',
    });

    const result = await adapter.searchProducts({ query: 'milk' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(SourceWarningCode.RealSourceNotImplemented);
      expect(result.error.message).toContain('Coop product source');
    }
  });

  it('returns REAL_SOURCE_NOT_IMPLEMENTED for promotions', async () => {
    const adapter = new UnsupportedChainAdapter('migros', {
      promotions: 'No approved Migros promotions source.',
    });

    const result = await adapter.searchPromotions({ query: 'milk' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(SourceWarningCode.RealSourceNotImplemented);
    }
  });

  it('returns REAL_SOURCE_NOT_IMPLEMENTED for store search', async () => {
    const adapter = new UnsupportedChainAdapter('lidl');

    const result = await adapter.findStores({ location: 'Zurich' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(SourceWarningCode.RealSourceNotImplemented);
    }
  });

  it('returns unsupported availability without pretending a store exists', async () => {
    const adapter = new UnsupportedChainAdapter('coop', {});

    const result = await adapter.lookupStoreProductAvailability({
      storeId: 'any-store',
      query: 'milk',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.supported).toBe(false);
      expect(result.data.isAvailable).toBe(false);
      expect(result.data.matches).toEqual([]);
    }
  });

  it('reports getStoreAvailabilitySupport as unsupported', () => {
    const adapter = new UnsupportedChainAdapter('volg');

    const support = adapter.getStoreAvailabilitySupport();

    expect(support.supported).toBe(false);
    expect(support.chain).toBe('volg');
  });

  it('includes chain and hint in error message', async () => {
    const adapter = new UnsupportedChainAdapter('farmy', {
      productSearch: 'Farmy operations ceased.',
    });

    const result = await adapter.searchProducts({ query: 'bread' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('farmy');
      expect(result.error.message).toContain('get_source_status');
    }
  });

  it('uses default reason when no specific reason is configured', async () => {
    const adapter = new UnsupportedChainAdapter('ottos');

    const result = await adapter.searchProducts({ query: 'cheese' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(SourceWarningCode.RealSourceNotImplemented);
      expect(result.error.message).toContain('ottos');
    }
  });
});
