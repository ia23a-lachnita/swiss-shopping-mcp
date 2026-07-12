import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FileTtlCache } from '../cache/fileTtlCache.js';
import {
  createWebSearchProviderFromEnv,
  WebSearchProvider,
} from '../sources/webSearch.js';
import {
  Chain,
  ChainAdapter,
  NormalizedProduct,
  ProductSearchFilters,
  SourceWarning,
  SourceWarningCode,
} from '../adapters/types.js';
import { normalize } from '../util/matcher.js';

/**
 * Per-chain configuration for mapping web-search result URLs back to vendor
 * product IDs. Only chains with a reliable product-URL scheme AND an adapter
 * getProductsByIds implementation participate in web-augmented search.
 */
export interface WebSearchChainConfig {
  chain: Chain;
  /** Site restriction passed to the search engine (may include path prefix). */
  site: string;
  /** Extract the vendor product ID from a product page URL. */
  extractProductId: (url: URL) => string | undefined;
}

const MIGROS_PRODUCT_ID_PATTERN = /\/product\/(?:mo\/)?(\d{4,})/;
const COOP_PRODUCT_ID_PATTERN = /\/p\/(\d+)/;

export const DEFAULT_WEB_SEARCH_CHAIN_CONFIGS: WebSearchChainConfig[] = [
  {
    chain: 'migros',
    site: 'migros.ch/de/product',
    extractProductId: (url) => url.pathname.match(MIGROS_PRODUCT_ID_PATTERN)?.[1],
  },
  {
    chain: 'coop',
    site: 'coop.ch',
    extractProductId: (url) => url.pathname.match(COOP_PRODUCT_ID_PATTERN)?.[1],
  },
];

export interface WebProductSearchResult {
  /** Products per chain, ordered by web-search rank. */
  productsByChain: Map<Chain, NormalizedProduct[]>;
  warnings: SourceWarning[];
  providerName: string;
}

export interface WebProductSearchServiceOptions {
  provider: WebSearchProvider;
  adapters: ChainAdapter[];
  cache: FileTtlCache;
  chainConfigs?: WebSearchChainConfig[];
  /** TTL for cached query -> product-ID lists. Default 24h. */
  cacheTtlMs?: number;
  /** Max product IDs hydrated per chain per query. Default 6. */
  maxProductsPerChain?: number;
}

const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_PRODUCTS_PER_CHAIN = 6;
const WEB_SEARCH_PROVIDER_LABEL = 'WebSearch';

function passesFilterConstraints(product: NormalizedProduct, filters: ProductSearchFilters): boolean {
  if (product.price.current <= 0) {
    return false;
  }
  if (typeof filters.maxPrice === 'number' && product.price.current > filters.maxPrice) {
    return false;
  }
  if (filters.category && normalize(product.category ?? '') !== normalize(filters.category)) {
    return false;
  }
  const requestedTags = (filters.tags ?? []).map((tag) => normalize(tag));
  const productTags = new Set((product.tags ?? []).map((tag) => normalize(tag)));
  return requestedTags.every((tag) => productTags.has(tag));
}

/**
 * Semantic product discovery: issues site-restricted web searches per chain,
 * extracts vendor product IDs from the ranked result URLs, and hydrates full
 * product data through the chain adapters' getProductsByIds implementations.
 *
 * Web-search failures never fail the overall search — they degrade to vendor
 * results with a source warning.
 */
export class WebProductSearchService {
  private readonly provider: WebSearchProvider;
  private readonly cache: FileTtlCache;
  private readonly cacheTtlMs: number;
  private readonly maxProductsPerChain: number;
  private readonly configsByChain: Map<Chain, WebSearchChainConfig>;
  private readonly adaptersByChain: Map<Chain, ChainAdapter>;

  public constructor(options: WebProductSearchServiceOptions) {
    this.provider = options.provider;
    this.cache = options.cache;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxProductsPerChain = options.maxProductsPerChain ?? DEFAULT_MAX_PRODUCTS_PER_CHAIN;

    const configs = options.chainConfigs ?? DEFAULT_WEB_SEARCH_CHAIN_CONFIGS;
    this.configsByChain = new Map(configs.map((config) => [config.chain, config]));
    this.adaptersByChain = new Map(options.adapters.map((adapter) => [adapter.chain, adapter]));
  }

  public get providerName(): string {
    return this.provider.name;
  }

  public supportsChain(chain: Chain): boolean {
    const adapter = this.adaptersByChain.get(chain);
    return this.configsByChain.has(chain) && typeof adapter?.getProductsByIds === 'function';
  }

  public async searchProducts(
    filters: ProductSearchFilters,
    chains: Chain[]
  ): Promise<WebProductSearchResult> {
    const query = filters.query.trim();
    const supportedChains = chains.filter((chain) => this.supportsChain(chain));

    const productsByChain = new Map<Chain, NormalizedProduct[]>();
    const warnings: SourceWarning[] = [];
    if (!query || supportedChains.length === 0) {
      return { productsByChain, warnings, providerName: this.provider.name };
    }

    await Promise.all(
      supportedChains.map(async (chain) => {
        try {
          const products = await this.searchChain(chain, query, filters, warnings);
          if (products.length > 0) {
            productsByChain.set(chain, products);
          }
        } catch (error) {
          warnings.push(this.warningFor(chain, error));
        }
      })
    );

    return { productsByChain, warnings, providerName: this.provider.name };
  }

  private async searchChain(
    chain: Chain,
    query: string,
    filters: ProductSearchFilters,
    warnings: SourceWarning[]
  ): Promise<NormalizedProduct[]> {
    const config = this.configsByChain.get(chain)!;
    const adapter = this.adaptersByChain.get(chain)!;

    const ids = await this.discoverProductIds(chain, config, query);
    if (ids.length === 0) {
      return [];
    }

    const hydrated = await adapter.getProductsByIds!(ids);
    if (!hydrated.ok) {
      warnings.push({
        chain,
        provider: WEB_SEARCH_PROVIDER_LABEL,
        code: (Object.values(SourceWarningCode) as string[]).includes(hydrated.error.code)
          ? (hydrated.error.code as SourceWarningCode)
          : SourceWarningCode.SourceUnavailable,
        message: `Web-discovered ${chain} products could not be hydrated: ${hydrated.error.message ?? hydrated.error.code}`,
        observedAt: new Date().toISOString(),
      });
      return [];
    }

    if (hydrated.metadata?.sourceWarnings) {
      warnings.push(...hydrated.metadata.sourceWarnings);
    }

    return hydrated.data
      .filter((product) => passesFilterConstraints(product, filters))
      .map((product) => ({
        ...product,
        matchExplanation: {
          strength: 1,
          matchedBy: ['provider-rank' as const],
          matchedTerms: [query],
        },
      }));
  }

  private async discoverProductIds(
    chain: Chain,
    config: WebSearchChainConfig,
    query: string
  ): Promise<string[]> {
    const cacheKey = `websearch:${this.provider.name}:${chain}:${normalize(query)}`;
    const cached = await this.cache.get<{ ids: string[] }>(cacheKey, { allowStale: true });
    if (cached && !cached.isStale) {
      return cached.data.ids;
    }

    let ids: string[];
    try {
      const results = await this.provider.search(query, { site: config.site });
      const seen = new Set<string>();
      ids = [];
      for (const result of results) {
        let parsed: URL;
        try {
          parsed = new URL(result.url);
        } catch {
          continue;
        }
        const id = config.extractProductId(parsed);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= this.maxProductsPerChain) break;
      }
    } catch (error) {
      if (cached) {
        // Stale ID list is better than none when the search engine is down.
        return cached.data.ids;
      }
      throw error;
    }

    // Never cache empty ID lists: they are usually transient engine issues
    // (rate limiting, index lag) and would pin bad results for a whole day.
    if (ids.length > 0) {
      await this.cache.set(
        cacheKey,
        { ids },
        {
          provider: WEB_SEARCH_PROVIDER_LABEL,
          chain,
          sourceType: 'third-party',
          sourceUrl: undefined,
          confidence: 'medium',
        },
        this.cacheTtlMs
      );
    }

    return ids;
  }

  private warningFor(chain: Chain, error: unknown): SourceWarning {
    const message = error instanceof Error ? error.message : String(error);
    return {
      chain,
      provider: WEB_SEARCH_PROVIDER_LABEL,
      code: SourceWarningCode.SourceUnavailable,
      message: `Web search (${this.provider.name}) failed for ${chain}: ${message}`,
      observedAt: new Date().toISOString(),
    };
  }
}

export interface CreateDefaultWebProductSearchOptions {
  cacheDirectory?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/**
 * Create the default web product search service from environment settings.
 * Returns undefined when web search is disabled (SWISS_SHOPPING_WEB_SEARCH=off
 * or mode=google without API keys).
 */
export function createDefaultWebProductSearch(
  adapters: ChainAdapter[],
  options: CreateDefaultWebProductSearchOptions = {}
): WebProductSearchService | undefined {
  const env = options.env ?? process.env;
  const provider = createWebSearchProviderFromEnv(env, options.fetchImpl);
  if (!provider) {
    return undefined;
  }

  const cacheDirectory =
    options.cacheDirectory ??
    env.SWISS_SHOPPING_CACHE_DIR ??
    join(tmpdir(), 'swiss-shopping-mcp-cache');

  return new WebProductSearchService({
    provider,
    adapters,
    cache: new FileTtlCache(cacheDirectory),
  });
}
