import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FileTtlCache } from '../cache/fileTtlCache.js';
import { SourceHttpClient } from '../sources/sourceClient.js';
import { AldiLiveAdapter } from './live/aldiLiveAdapter.js';
import { DennerPromotionsAdapter } from './live/dennerPromotionsAdapter.js';
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
    migros: {
      productSearch:
        'Migros product search is blocked pending a provider or maintained index decision.',
      promotions: 'Migros promotion paths are blocked.',
      storeSearch: 'Migros store source requires a public source audit before runtime use.',
      availability: 'No Migros store-level availability source is implemented.',
      nutrition: 'Open-data or provider enrichment decision required for Migros nutrition.',
    },
    coop: {
      productSearch: 'Coop product search endpoints are blocked or unsuitable.',
      promotions: 'No approved Coop promotions source is implemented.',
      storeSearch: 'Coop store source requires an endpoint audit.',
      availability: 'No Coop store-level availability source is implemented.',
      nutrition: 'No Coop nutrition enrichment source is implemented.',
    },
    lidl: {
      productSearch: 'Lidl product sitemap feasibility still needs parser and source review.',
      promotions: 'No approved Lidl promotions source is implemented.',
      storeSearch: 'Lidl store finder sitemap requires audit.',
      availability: 'No Lidl store-level availability source is implemented.',
      nutrition: 'No Lidl nutrition enrichment source is implemented.',
    },
    farmy: {
      productSearch: 'Farmy operations have ceased.',
      promotions: 'Farmy operations have ceased.',
      storeSearch: 'Farmy operations have ceased.',
      availability: 'Farmy operations have ceased.',
      nutrition: 'Farmy operations have ceased.',
    },
    volg: {
      productSearch: 'No Volg product catalog or price source is available.',
      promotions: 'Volg promotion source requires audit.',
      storeSearch: 'Volg store locator source requires audit.',
      availability: 'No Volg store-level availability source is implemented.',
      nutrition: 'No Volg nutrition enrichment source is implemented.',
    },
    ottos: {
      productSearch: "Otto's category/product pages need a high-caution audit.",
      promotions: "Otto's promotion source needs a high-caution audit.",
      storeSearch: "Otto's store source requires audit.",
      availability: "No Otto's store-level availability source is implemented.",
      nutrition: "No Otto's nutrition enrichment source is implemented.",
    },
  };

export interface CreateDefaultAdaptersOptions {
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

  const delegate = new UnsupportedChainAdapter('denner', {
    productSearch: 'Denner product catalog search is not backed by a real source yet.',
    storeSearch: 'Denner store lookup is not backed by a real source yet.',
    availability: 'Denner store-level availability is not backed by a real source.',
  });

  return new DennerPromotionsAdapter({
    delegate,
    cache: new FileTtlCache(cacheDirectory),
    sourceClient: new SourceHttpClient({ fetchImpl: options.fetchImpl, rateLimitPerHostMs: 1_000 }),
  });
}

export function createDefaultAdapters(options: CreateDefaultAdaptersOptions = {}): ChainAdapter[] {
  return ALL_CHAINS.map((chain) => {
    if (chain === 'aldi') return createAldiLiveAdapter(options);
    if (chain === 'denner') return createDennerPromotionsAdapter(options);

    return new UnsupportedChainAdapter(chain, UNSUPPORTED_CHAIN_REASONS[chain] ?? {});
  });
}
