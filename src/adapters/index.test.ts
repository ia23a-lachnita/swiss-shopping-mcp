import { describe, expect, it } from 'vitest';

import { AldiLiveAdapter } from './live/aldiLiveAdapter.js';
import { CoopLiveAdapter } from './live/coopLiveAdapter.js';
import { DennerPromotionsAdapter } from './live/dennerPromotionsAdapter.js';
import { LidlLiveAdapter } from './live/lidlLiveAdapter.js';
import { MigrosLiveAdapter } from './live/migrosLiveAdapter.js';
import { OttosLiveAdapter } from './live/ottosLiveAdapter.js';
import { VolgLiveAdapter } from './live/volgLiveAdapter.js';
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

  it('uses the Migros live-beta adapter by default', () => {
    const adapters = createDefaultAdapters({ cacheDirectory: 'test-cache' });
    const migrosAdapter = adapters.find((adapter) => adapter.chain === 'migros');

    expect(migrosAdapter).toBeInstanceOf(MigrosLiveAdapter);
  });

  it('uses the Coop live-beta adapter by default', () => {
    const adapters = createDefaultAdapters({ cacheDirectory: 'test-cache' });
    const coopAdapter = adapters.find((adapter) => adapter.chain === 'coop');

    expect(coopAdapter).toBeInstanceOf(CoopLiveAdapter);
  });

  it('uses the Lidl live-beta adapter by default', () => {
    const adapters = createDefaultAdapters({ cacheDirectory: 'test-cache' });
    const lidlAdapter = adapters.find((adapter) => adapter.chain === 'lidl');

    expect(lidlAdapter).toBeInstanceOf(LidlLiveAdapter);
  });

  it("uses the Otto's live-beta adapter by default", () => {
    const adapters = createDefaultAdapters({ cacheDirectory: 'test-cache' });
    const ottosAdapter = adapters.find((adapter) => adapter.chain === 'ottos');

    expect(ottosAdapter).toBeInstanceOf(OttosLiveAdapter);
  });

  it('uses the Volg live-beta adapter by default', () => {
    const adapters = createDefaultAdapters({ cacheDirectory: 'test-cache' });
    const volgAdapter = adapters.find((adapter) => adapter.chain === 'volg');

    expect(volgAdapter).toBeInstanceOf(VolgLiveAdapter);
  });

  it('does not expose legacy static mode in default adapter creation', () => {
    const adapters = createDefaultAdapters({ cacheDirectory: 'test-cache' });

    expect(adapters).toHaveLength(8);
    expect(adapters.map((adapter) => adapter.constructor.name)).not.toContain('StaticChainAdapter');
  });

  it('returns an UnsupportedChainAdapter only for farmy', () => {
    const adapters = createDefaultAdapters({ cacheDirectory: 'test-cache' });
    const farmyAdapter = adapters.find((a) => a.chain === 'farmy');

    expect(farmyAdapter?.constructor.name).toBe('UnsupportedChainAdapter');
  });
});
