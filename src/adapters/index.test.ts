import { describe, expect, it } from 'vitest';

import { AldiLiveAdapter } from './live/aldiLiveAdapter.js';
import { DennerPromotionsAdapter } from './live/dennerPromotionsAdapter.js';
import { createDefaultAdapters } from './index.js';
import { StaticChainAdapter } from './staticChainAdapter.js';

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

  it('can create deterministic legacy static adapters for tests', () => {
    const adapters = createDefaultAdapters({ dataMode: 'legacy-static' });
    const aldiAdapter = adapters.find((adapter) => adapter.chain === 'aldi');
    const dennerAdapter = adapters.find((adapter) => adapter.chain === 'denner');

    expect(aldiAdapter).toBeInstanceOf(StaticChainAdapter);
    expect(dennerAdapter).toBeInstanceOf(StaticChainAdapter);
  });
});
