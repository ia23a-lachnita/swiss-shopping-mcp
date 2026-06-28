import { ALL_CHAINS } from './index.js';
import { CapabilitySourceStatus, Chain, SourceCapability } from './types.js';

export const SOURCE_REGISTRY: Record<Chain, CapabilitySourceStatus[]> = {
  aldi: [
    {
      chain: 'aldi',
      capability: 'productSearch',
      status: 'live-beta',
      provider: 'ALDI SUISSE',
      sourceType: 'retailer-web',
    },
    {
      chain: 'aldi',
      capability: 'promotions',
      status: 'unsupported',
      reason: 'No approved Aldi promotions source is implemented.',
    },
    {
      chain: 'aldi',
      capability: 'storeSearch',
      status: 'unsupported',
      reason: 'No approved Aldi store source is implemented.',
    },
    {
      chain: 'aldi',
      capability: 'availability',
      status: 'unsupported',
      reason: 'No store-level Aldi availability source is implemented.',
    },
    {
      chain: 'aldi',
      capability: 'nutrition',
      status: 'unsupported',
      reason: 'No Aldi nutrition enrichment source is implemented.',
    },
  ],
  denner: [
    {
      chain: 'denner',
      capability: 'promotions',
      status: 'live-beta',
      provider: 'Denner',
      sourceType: 'retailer-web',
    },
    {
      chain: 'denner',
      capability: 'productSearch',
      status: 'live-beta',
      provider: 'Denner',
      sourceType: 'retailer-web',
    },
    {
      chain: 'denner',
      capability: 'storeSearch',
      status: 'unsupported',
      reason: 'No approved Denner store source is implemented.',
    },
    {
      chain: 'denner',
      capability: 'availability',
      status: 'unsupported',
      reason: 'No Denner store-level availability source is implemented.',
    },
    {
      chain: 'denner',
      capability: 'nutrition',
      status: 'unsupported',
      reason: 'No Denner nutrition enrichment source is implemented.',
    },
  ],
  coop: [
    {
      chain: 'coop',
      capability: 'productSearch',
      status: 'live-beta',
      provider: 'Coop',
      sourceType: 'retailer-web',
    },
    {
      chain: 'coop',
      capability: 'promotions',
      status: 'unsupported',
      reason: 'Coop promotions search is not yet implemented.',
    },
    {
      chain: 'coop',
      capability: 'storeSearch',
      status: 'live-beta',
      provider: 'Coop',
      sourceType: 'retailer-web',
    },
    {
      chain: 'coop',
      capability: 'availability',
      status: 'live-beta',
      provider: 'Coop',
      sourceType: 'retailer-web',
      reason: 'Store availability via GET /locations/searchAroundCoordinates?latitude={lat}&longitude={lon}&availabilityProductId={id}.',
    },
    {
      chain: 'coop',
      capability: 'nutrition',
      status: 'live-beta',
      provider: 'Coop',
      sourceType: 'retailer-web',
      reason: 'Nutrition and ingredients from REST product detail API (top 5 products enriched per search).',
    },
  ],
  farmy: [
    {
      chain: 'farmy',
      capability: 'productSearch',
      status: 'blocked',
      reason: 'Source audit found Farmy operations ceased.',
    },
    {
      chain: 'farmy',
      capability: 'promotions',
      status: 'blocked',
      reason: 'Source audit found Farmy operations ceased.',
    },
    {
      chain: 'farmy',
      capability: 'storeSearch',
      status: 'blocked',
      reason: 'Source audit found Farmy operations ceased.',
    },
    {
      chain: 'farmy',
      capability: 'availability',
      status: 'blocked',
      reason: 'Source audit found Farmy operations ceased.',
    },
    {
      chain: 'farmy',
      capability: 'nutrition',
      status: 'blocked',
      reason: 'Source audit found Farmy operations ceased.',
    },
  ],
  lidl: [
    {
      chain: 'lidl',
      capability: 'productSearch',
      status: 'live-beta',
      provider: 'Lidl Schweiz',
      sourceType: 'retailer-web',
    },
    {
      chain: 'lidl',
      capability: 'promotions',
      status: 'unsupported',
      reason: 'Lidl promotions API returns campaign groups without product items. No product-level promotions data available.',
    },
    {
      chain: 'lidl',
      capability: 'storeSearch',
      status: 'live-beta',
      provider: 'Lidl Schweiz',
      sourceType: 'retailer-web',
    },
    {
      chain: 'lidl',
      capability: 'availability',
      status: 'unsupported',
      reason: 'Lidl does not expose store-level product availability.',
    },
    {
      chain: 'lidl',
      capability: 'nutrition',
      status: 'unsupported',
      reason: 'No Lidl nutrition enrichment source is implemented.',
    },
  ],
  migros: [
    {
      chain: 'migros',
      capability: 'productSearch',
      status: 'live-beta',
      provider: 'Migros',
      sourceType: 'retailer-web',
      reason: 'Uses Playwright browser to bypass Cloudflare bot protection.',
    },
    {
      chain: 'migros',
      capability: 'promotions',
      status: 'unsupported',
      reason: 'Migros promotions search is not yet implemented.',
    },
    {
      chain: 'migros',
      capability: 'storeSearch',
      status: 'live-beta',
      provider: 'Migros',
      sourceType: 'retailer-web',
      reason: 'Uses Playwright browser to bypass Cloudflare bot protection.',
    },
    {
      chain: 'migros',
      capability: 'availability',
      status: 'live-beta',
      provider: 'Migros',
      sourceType: 'retailer-web',
      reason: 'Uses Playwright browser to bypass Cloudflare bot protection. Store availability via GET /store-availability/public/v2/availabilities/products/{pid}?costCenterIds={storeId}.',
    },
    {
      chain: 'migros',
      capability: 'nutrition',
      status: 'live-beta',
      provider: 'Migros',
      sourceType: 'retailer-web',
      reason: 'Uses Playwright browser to bypass Cloudflare bot protection.',
    },
  ],
  ottos: [
    {
      chain: 'ottos',
      capability: 'productSearch',
      status: 'live-beta',
      provider: "Otto's",
      sourceType: 'retailer-web',
    },
    {
      chain: 'ottos',
      capability: 'promotions',
      status: 'unsupported',
      reason: "Otto's promotions search is not yet implemented.",
    },
    {
      chain: 'ottos',
      capability: 'storeSearch',
      status: 'live-beta',
      provider: "Otto's",
      sourceType: 'retailer-web',
    },
    {
      chain: 'ottos',
      capability: 'availability',
      status: 'unsupported',
      reason: "No Otto's store-level availability source is implemented.",
    },
    {
      chain: 'ottos',
      capability: 'nutrition',
      status: 'unsupported',
      reason: "No Otto's nutrition enrichment source is implemented.",
    },
  ],
  volg: [
    {
      chain: 'volg',
      capability: 'productSearch',
      status: 'live-beta',
      provider: 'Volg',
      sourceType: 'retailer-web',
    },
    {
      chain: 'volg',
      capability: 'promotions',
      status: 'unsupported',
      reason: 'Volg promotions search is not yet implemented.',
    },
    {
      chain: 'volg',
      capability: 'storeSearch',
      status: 'live-beta',
      provider: 'Volg',
      sourceType: 'retailer-web',
    },
    {
      chain: 'volg',
      capability: 'availability',
      status: 'unsupported',
      reason: 'No Volg store-level availability source is implemented.',
    },
    {
      chain: 'volg',
      capability: 'nutrition',
      status: 'unsupported',
      reason: 'No Volg nutrition enrichment source is implemented.',
    },
  ],
};

export function getCapabilityStatuses(
  chain: Chain,
  capabilities?: SourceCapability[]
): CapabilitySourceStatus[] {
  const statuses = SOURCE_REGISTRY[chain] ?? [];
  if (!capabilities || capabilities.length === 0) {
    return statuses;
  }
  return statuses.filter((status) => capabilities.includes(status.capability));
}

export function getAllCapabilityStatuses(
  chains?: Chain[],
  capabilities?: SourceCapability[]
): CapabilitySourceStatus[] {
  const targetChains = chains ?? ALL_CHAINS;
  return targetChains.flatMap((chain) => getCapabilityStatuses(chain, capabilities));
}
