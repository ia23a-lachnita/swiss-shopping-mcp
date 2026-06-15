import { describe, expect, it } from 'vitest';

import { AldiLiveAdapter } from './live/aldiLiveAdapter.js';
import { DennerPromotionsAdapter } from './live/dennerPromotionsAdapter.js';
import { createDefaultAdapters } from './index.js';

describe('createDefaultAdapters', () => {
  it('uses the Aldi live-beta adapter by default', () => {
    const adapters = createDefaultAdapters({ cacheDirectory: 'test-cache' });
    const aldiAdapter = adapters.find((adapter) => adapter.chain === 'aldi');

    expect(aldiAdapter).toBeInstanceOf(AldiLiveAdapter);
  });

  it('uses the Denner promotions live-beta adapter by default', () => {
    const adapters = createDefaultAdapters({ cacheDirectory: 'test-cache' });
    const dennerAdapter = adapters.find((adapter) => adapter.chain === 'denner');

    expect(dennerAdapter).toBeInstanceOf(DennerPromotionsAdapter);
  });

  it('does not expose legacy static mode in default adapter creation', () => {
    const adapters = createDefaultAdapters({ cacheDirectory: 'test-cache' });

    expect(adapters).toHaveLength(8);
    expect(adapters.map((adapter) => adapter.constructor.name)).not.toContain('StaticChainAdapter');
  });

  it('returns an UnsupportedChainAdapter for chains without a live source', () => {
    const adapters = createDefaultAdapters({ cacheDirectory: 'test-cache' });
    const unsupportedChains = ['migros', 'coop', 'lidl', 'farmy', 'volg', 'ottos'];

    for (const chain of unsupportedChains) {
      const adapter = adapters.find((a) => a.chain === chain);
      expect(adapter?.constructor.name, `${chain} should use UnsupportedChainAdapter`).toBe(
        'UnsupportedChainAdapter'
      );
    }
  });
});
