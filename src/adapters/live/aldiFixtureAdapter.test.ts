import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { parseAldiProductPage } from '../../parsers/aldi.js';
import { AldiFixtureAdapter } from './aldiFixtureAdapter.js';

async function createAdapter(): Promise<AldiFixtureAdapter> {
  const html = await readFile(
    new URL('../../../fixtures/live-sources/aldi/product-toskanabrot.sample.html', import.meta.url),
    'utf8',
  );

  return new AldiFixtureAdapter({
    products: [parseAldiProductPage(html)],
    observedAt: '2026-05-18T10:00:00.000Z',
    cacheExpiresAt: '2026-05-19T10:00:00.000Z',
  });
}

describe('AldiFixtureAdapter', () => {
  it('searches parsed Aldi fixture products with provenance', async () => {
    const adapter = await createAdapter();

    const result = await adapter.searchProducts({ query: 'toskanabrot' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      id: 'backbox-toskanabrot-000000000000101698',
      chain: 'aldi',
      name: 'Toskanabrot',
      brand: 'BACKBOX',
      price: { current: 2.19 },
      category: 'Grillen',
      tags: ['in-stock'],
      provenance: {
        provider: 'ALDI SUISSE',
        chain: 'aldi',
        sourceType: 'retailer-web',
        sourceUrl: 'https://www.aldi-suisse.ch/de/produkt/backbox-toskanabrot-000000000000101698',
        observedAt: '2026-05-18T10:00:00.000Z',
        freshness: 'cached',
        cacheExpiresAt: '2026-05-19T10:00:00.000Z',
        confidence: 'medium',
      },
    });
  });

  it('supports category, price, tag, and limit filters', async () => {
    const adapter = await createAdapter();

    const categoryResult = await adapter.searchProducts({ query: 'brot', category: 'Grillen' });
    const expensiveResult = await adapter.searchProducts({ query: 'brot', maxPrice: 2 });
    const tagResult = await adapter.searchProducts({ query: 'brot', tags: ['in-stock'], limit: 1 });

    expect(categoryResult.ok && categoryResult.data).toHaveLength(1);
    expect(expensiveResult.ok && expensiveResult.data).toHaveLength(0);
    expect(tagResult.ok && tagResult.data).toHaveLength(1);
  });

  it('returns explicit validation errors for blank product queries', async () => {
    const adapter = await createAdapter();

    const result = await adapter.searchProducts({ query: '   ' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_QUERY');
    }
  });

  it('does not implement store search or store-level availability', async () => {
    const adapter = await createAdapter();

    const stores = await adapter.findStores({ location: 'zürich' });
    const support = adapter.getStoreAvailabilitySupport();
    const availability = await adapter.lookupStoreProductAvailability({
      storeId: 'aldi-zurich',
      query: 'toskanabrot',
    });

    expect(stores.ok).toBe(false);
    if (!stores.ok) {
      expect(stores.error.code).toBe('REAL_SOURCE_NOT_IMPLEMENTED');
    }
    expect(support).toEqual({
      chain: 'aldi',
      supported: false,
      reason: 'Aldi fixture adapter does not expose store-level product availability.',
    });
    expect(availability.ok).toBe(true);
    if (availability.ok) {
      expect(availability.data.supported).toBe(false);
      expect(availability.data.isAvailable).toBe(false);
    }
  });
});
