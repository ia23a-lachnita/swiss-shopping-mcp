import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FileTtlCache } from '../cache/fileTtlCache.js';
import { SourceHttpClient } from '../sources/sourceClient.js';
import { AldiLiveAdapter } from './live/aldiLiveAdapter.js';
import { DennerPromotionsAdapter } from './live/dennerPromotionsAdapter.js';
import { STATIC_CHAIN_CATALOG } from './staticCatalog.js';
import { StaticChainAdapter } from './staticChainAdapter.js';
import { Chain, ChainAdapter } from './types.js';

const ALL_CHAINS: Chain[] = ['migros', 'coop', 'aldi', 'denner', 'lidl', 'farmy', 'volg', 'ottos'];

export interface CreateDefaultAdaptersOptions {
  dataMode?: 'live-beta' | 'legacy-static';
  cacheDirectory?: string;
  fetchImpl?: typeof fetch;
}

function createAldiLiveAdapter(options: CreateDefaultAdaptersOptions): ChainAdapter {
  const cacheDirectory =
    options.cacheDirectory ??
    process.env.SWISS_SHOPPING_CACHE_DIR ??
    join(tmpdir(), 'swiss-shopping-mcp-cache');

  return new AldiLiveAdapter({
    cache: new FileTtlCache(cacheDirectory),
    sourceClient: new SourceHttpClient({ fetchImpl: options.fetchImpl, rateLimitPerHostMs: 1_000 }),
  });
}

function createDennerPromotionsAdapter(options: CreateDefaultAdaptersOptions): ChainAdapter {
  const cacheDirectory =
    options.cacheDirectory ??
    process.env.SWISS_SHOPPING_CACHE_DIR ??
    join(tmpdir(), 'swiss-shopping-mcp-cache');
  const delegate = new StaticChainAdapter('denner', STATIC_CHAIN_CATALOG.denner);

  return new DennerPromotionsAdapter({
    delegate,
    cache: new FileTtlCache(cacheDirectory),
    sourceClient: new SourceHttpClient({ fetchImpl: options.fetchImpl, rateLimitPerHostMs: 1_000 }),
  });
}

export function createDefaultAdapters(options: CreateDefaultAdaptersOptions = {}): ChainAdapter[] {
  const dataMode = options.dataMode ?? 'live-beta';
  return ALL_CHAINS.map((chain) => {
    if (chain === 'aldi' && dataMode === 'live-beta') {
      return createAldiLiveAdapter(options);
    }

    if (chain === 'denner' && dataMode === 'live-beta') {
      return createDennerPromotionsAdapter(options);
    }

    return new StaticChainAdapter(chain, STATIC_CHAIN_CATALOG[chain]);
  });
}
