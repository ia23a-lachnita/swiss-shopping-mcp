import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FileTtlCache } from '../cache/fileTtlCache.js';
import { SourceHttpClient } from '../sources/sourceClient.js';
import { AldiLiveAdapter } from './live/aldiLiveAdapter.js';
import { CoopLiveAdapter } from './live/coopLiveAdapter.js';
import { DennerPromotionsAdapter } from './live/dennerPromotionsAdapter.js';
import { LidlLiveAdapter } from './live/lidlLiveAdapter.js';
import { MigrosLiveAdapter } from './live/migrosLiveAdapter.js';
import { OttosLiveAdapter } from './live/ottosLiveAdapter.js';
import { VolgLiveAdapter } from './live/volgLiveAdapter.js';
import { UnsupportedChainAdapter } from './unsupportedAdapter.js';
import { Chain, ChainAdapter, SourceCapability } from './types.js';

export const ALL_CHAINS: Chain[] = [
  'migros',
  'coop',
  'aldi',
  'denner',
  'lidl',
  'farmy',
  'volg',
  'ottos',
];

const UNSUPPORTED_CHAIN_REASONS: Partial<Record<Chain, Partial<Record<SourceCapability, string>>>> =
  {
    farmy: {
      productSearch: 'Farmy operations have ceased.',
      promotions: 'Farmy operations have ceased.',
      storeSearch: 'Farmy operations have ceased.',
      availability: 'Farmy operations have ceased.',
      nutrition: 'Farmy operations have ceased.',
    },
  };

export interface CreateDefaultAdaptersOptions {
  cacheDirectory?: string;
  fetchImpl?: typeof fetch;
}

function createAldiLiveAdapter(cache: FileTtlCache, sourceClient: SourceHttpClient): ChainAdapter {
  return new AldiLiveAdapter({ cache, sourceClient });
}

function createDennerPromotionsAdapter(cache: FileTtlCache, sourceClient: SourceHttpClient): ChainAdapter {
  const delegate = new UnsupportedChainAdapter('denner', {
    productSearch: 'Denner product catalog search is not backed by a real source yet.',
    storeSearch: 'Denner store lookup is not backed by a real source yet.',
    availability: 'Denner store-level availability is not backed by a real source.',
  });

  return new DennerPromotionsAdapter({ delegate, cache, sourceClient });
}

function createMigrosLiveAdapter(cache: FileTtlCache, _sourceClient: SourceHttpClient): ChainAdapter {
  return new MigrosLiveAdapter({ cache });
}

function createCoopLiveAdapter(cache: FileTtlCache, _sourceClient: SourceHttpClient): ChainAdapter {
  return new CoopLiveAdapter({ cache });
}

function createLidlLiveAdapter(cache: FileTtlCache, _sourceClient: SourceHttpClient): ChainAdapter {
  return new LidlLiveAdapter({ cache });
}

function createOttosLiveAdapter(cache: FileTtlCache, _sourceClient: SourceHttpClient): ChainAdapter {
  return new OttosLiveAdapter({ cache });
}

function createVolgLiveAdapter(cache: FileTtlCache, _sourceClient: SourceHttpClient): ChainAdapter {
  return new VolgLiveAdapter({ cache });
}

export function createDefaultAdapters(options: CreateDefaultAdaptersOptions = {}): ChainAdapter[] {
  const cacheDirectory =
    options.cacheDirectory ??
    process.env.SWISS_SHOPPING_CACHE_DIR ??
    join(tmpdir(), 'swiss-shopping-mcp-cache');

  const sharedCache = new FileTtlCache(cacheDirectory);
  const sharedSourceClient = new SourceHttpClient({ fetchImpl: options.fetchImpl, rateLimitPerHostMs: 1_000 });

  return ALL_CHAINS.map((chain) => {
    if (chain === 'aldi') return createAldiLiveAdapter(sharedCache, sharedSourceClient);
    if (chain === 'denner') return createDennerPromotionsAdapter(sharedCache, sharedSourceClient);
    if (chain === 'migros') return createMigrosLiveAdapter(sharedCache, sharedSourceClient);
    if (chain === 'coop') return createCoopLiveAdapter(sharedCache, sharedSourceClient);
    if (chain === 'lidl') return createLidlLiveAdapter(sharedCache, sharedSourceClient);
    if (chain === 'ottos') return createOttosLiveAdapter(sharedCache, sharedSourceClient);
    if (chain === 'volg') return createVolgLiveAdapter(sharedCache, sharedSourceClient);

    return new UnsupportedChainAdapter(chain, UNSUPPORTED_CHAIN_REASONS[chain] ?? {});
  });
}
