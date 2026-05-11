import { STATIC_CHAIN_CATALOG } from './staticCatalog.js';
import { StaticChainAdapter } from './staticChainAdapter.js';
import { Chain, ChainAdapter } from './types.js';

const ALL_CHAINS: Chain[] = ['migros', 'coop', 'aldi', 'denner', 'lidl', 'farmy', 'volg', 'ottos'];

export function createDefaultAdapters(): ChainAdapter[] {
  return ALL_CHAINS.map((chain) => new StaticChainAdapter(chain, STATIC_CHAIN_CATALOG[chain]));
}
