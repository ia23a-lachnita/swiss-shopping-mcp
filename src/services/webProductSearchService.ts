import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FileTtlCache } from '../cache/fileTtlCache.js';
import { DISCOVERY, EMPTY_SEARCH } from '../cache/freshnessPolicy.js';
import { createProviderBudgetFromEnv } from '../cache/providerBudget.js';
import { SourceCircuitBreaker } from './sourceCircuitBreaker.js';
import {
  createWebSearchProviderFromEnv,
  CompositeWebSearchProvider,
  WebSearchProvider,
  WebSearchResult,
} from '../sources/webSearch.js';
import {
  Chain,
  ChainAdapter,
  NormalizedProduct,
  ProductSearchFilters,
  SourceWarning,
  SourceWarningCode,
} from '../adapters/types.js';
import { CatalogService } from '../catalog/catalogService.js';
import { normalize } from '../util/matcher.js';
import { logger } from '../util/log.js';

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
  /** Per-chain cap on hydrated IDs (overrides the service default). */
  maxProducts?: number;
}

const MIGROS_PRODUCT_ID_PATTERN = /\/product\/(?:mo\/)?(\d{4,})/;
const COOP_PRODUCT_ID_PATTERN = /\/p\/(\d+)/;
// Lidl product pages end in /p{numericId}, e.g. /p/de-CH/vollmilch/p10054750.
// The whole pathname is the hydration ID because the product page fetch needs
// the full slug, not just the numeric ID (Lidl search cannot resolve bare IDs).
const LIDL_PRODUCT_PATH_PATTERN = /\/p(\d{5,})\/?$/;
// Aldi product slugs end in an 18-digit SKU, e.g.
// /de/produkt/backbox-toskanabrot-000000000000101698.
const ALDI_PRODUCT_SKU_SUFFIX = /\d{18}$/;

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
  {
    chain: 'aldi',
    site: 'aldi-suisse.ch/de/produkt',
    extractProductId: (url): string | undefined => {
      if (!url.pathname.includes('/produkt/')) {
        return undefined;
      }
      const slug = url.pathname.split('/').filter(Boolean).at(-1);
      return slug && ALDI_PRODUCT_SKU_SUFFIX.test(slug) ? slug : undefined;
    },
  },
  {
    chain: 'lidl',
    site: 'lidl.ch',
    extractProductId: (url) =>
      LIDL_PRODUCT_PATH_PATTERN.test(url.pathname) ? url.pathname : undefined,
    // Each cold lookup is a full product page fetch — keep it tight.
    maxProducts: 3,
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
  /** Max product IDs hydrated per chain per query. Default 6. */
  maxProductsPerChain?: number;
  /** Optional catalog for recording hydration outcomes and upserting web-discovered products. */
  catalog?: CatalogService;
}

const DEFAULT_MAX_PRODUCTS_PER_CHAIN = 6;
const WEB_SEARCH_PROVIDER_LABEL = 'WebSearch';

/** Shape of a cached discovery mapping. */
interface CachedDiscoveryMapping {
  ids: string[];
  /** Distinguishes confirmed zero results from a provider error. */
  emptyResult?: boolean;
  /** Timestamp when a forced rediscovery was last triggered for this mapping. */
  lastRediscoveryAt?: string;
}

interface HydrationHealth {
  total: number;
  succeeded: number;
}

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
  private readonly maxProductsPerChain: number;
  private readonly configsByChain: Map<Chain, WebSearchChainConfig>;
  private readonly adaptersByChain: Map<Chain, ChainAdapter>;
  /** In-flight dedup: key → promise. Cleaned up in finally. */
  private readonly inFlight = new Map<string, Promise<string[]>>();
  /** Per-query hydration health tracking to prevent rediscovery loops. */
  private readonly hydrationHealth = new Map<string, HydrationHealth>();
  /** Set of cache keys where a forced rediscovery already happened this soft-TTL cycle. */
  private readonly rediscoveryDone = new Set<string>();
  private readonly catalog?: CatalogService;

  public constructor(options: WebProductSearchServiceOptions) {
    this.provider = options.provider;
    this.cache = options.cache;
    this.maxProductsPerChain = options.maxProductsPerChain ?? DEFAULT_MAX_PRODUCTS_PER_CHAIN;
    this.catalog = options.catalog;

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

    // Deliverable 5: aggregated multi-site search when provider supports it
    const compositeProvider = this.provider instanceof CompositeWebSearchProvider
      ? this.provider
      : undefined;

    if (compositeProvider && supportedChains.length > 1) {
      await this.searchAggregated(compositeProvider, query, filters, supportedChains, productsByChain, warnings);
    } else {
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
    }

    return { productsByChain, warnings, providerName: this.provider.name };
  }

  private async searchAggregated(
    compositeProvider: CompositeWebSearchProvider,
    query: string,
    filters: ProductSearchFilters,
    supportedChains: Chain[],
    productsByChain: Map<Chain, NormalizedProduct[]>,
    warnings: SourceWarning[],
  ): Promise<void> {
    const sites = supportedChains
      .map((chain) => this.configsByChain.get(chain))
      .filter((config): config is WebSearchChainConfig => config !== undefined)
      .map((config) => config.site);

    let aggregatedResults: WebSearchResult[];
    try {
      aggregatedResults = await compositeProvider.searchAggregated(query, sites);
    } catch (error) {
      // Aggregated search failed — fall back to per-chain searches
      aggregatedResults = [];
      warnings.push({
        provider: WEB_SEARCH_PROVIDER_LABEL,
        code: SourceWarningCode.SourceUnavailable,
        message: `Aggregated web search failed: ${error instanceof Error ? error.message : String(error)}`,
        observedAt: new Date().toISOString(),
      });
    }

    // Group results by chain using the site restriction
    const resultsByChain = this.groupResultsByChain(aggregatedResults, supportedChains);

    // For chains with results from aggregated search, extract and hydrate IDs
    const chainsWithResults = new Set<Chain>();
    await Promise.all(
      supportedChains.map(async (chain) => {
        const chainResults = resultsByChain.get(chain);
        if (chainResults && chainResults.length > 0) {
          try {
            const products = await this.hydrateFromResults(chain, chainResults, query, filters, warnings);
            if (products.length > 0) {
              productsByChain.set(chain, products);
              chainsWithResults.add(chain);
            }
          } catch (error) {
            warnings.push(this.warningFor(chain, error));
          }
        }
      })
    );

    // Deliverable 5: per-retailer targeted searches for retailers missing from aggregated results
    const missingChains = supportedChains.filter((chain) => !chainsWithResults.has(chain));
    if (missingChains.length > 0) {
      await Promise.all(
        missingChains.map(async (chain) => {
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
    }
  }

  private groupResultsByChain(
    results: WebSearchResult[],
    chains: Chain[],
  ): Map<Chain, WebSearchResult[]> {
    const byChain = new Map<Chain, WebSearchResult[]>();
    for (const chain of chains) {
      byChain.set(chain, []);
    }

    for (const result of results) {
      let parsed: URL;
      try {
        parsed = new URL(result.url);
      } catch {
        continue;
      }
      for (const chain of chains) {
        const config = this.configsByChain.get(chain);
        if (!config) continue;
        const host = config.site.split('/')[0].toLowerCase();
        const hostname = parsed.hostname.toLowerCase();
        if (hostname === host || hostname.endsWith(`.${host}`)) {
          byChain.get(chain)!.push(result);
          break;
        }
      }
    }

    return byChain;
  }

  private async hydrateFromResults(
    chain: Chain,
    results: WebSearchResult[],
    query: string,
    filters: ProductSearchFilters,
    warnings: SourceWarning[],
  ): Promise<NormalizedProduct[]> {
    const config = this.configsByChain.get(chain)!;
    const adapter = this.adaptersByChain.get(chain)!;
    const maxProducts = config.maxProducts ?? this.maxProductsPerChain;

    const seen = new Set<string>();
    const ids: string[] = [];
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
      if (ids.length >= maxProducts) break;
    }

    if (ids.length === 0) return [];

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
      // Catalog: record transient failure for all requested IDs
      if (this.catalog) {
        try {
          for (const id of ids) {
            this.catalog.recordHydrationFailure(chain, id, 'transient');
          }
        } catch (err) {
          logger.warn('Catalog recordHydrationFailure (web-discovery transient) failed:', err);
        }
      }
      return [];
    }

    if (hydrated.metadata?.sourceWarnings) {
      warnings.push(...hydrated.metadata.sourceWarnings);
    }

    // Catalog: record gone for missing IDs, upsert found products
    if (this.catalog) {
      try {
        const foundIds = new Set(hydrated.data.map((p) => p.id));
        for (const id of ids) {
          if (!foundIds.has(id)) {
            this.catalog.recordHydrationFailure(chain, id, 'gone');
          }
        }
        for (const product of hydrated.data) {
          this.catalog.upsertFromNormalizedProduct(product, 'web-discovery');
        }
      } catch (err) {
        logger.warn('Catalog upsert (web-discovery) failed:', err);
      }
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
      // Catalog: record transient failure for all requested IDs
      if (this.catalog) {
        try {
          for (const id of ids) {
            this.catalog.recordHydrationFailure(chain, id, 'transient');
          }
        } catch (err) {
          logger.warn('Catalog recordHydrationFailure (web-search transient) failed:', err);
        }
      }
      // Deliverable 6: track hydration health
      this.recordHydrationHealth(chain, query, ids.length, 0);
      return [];
    }

    if (hydrated.metadata?.sourceWarnings) {
      warnings.push(...hydrated.metadata.sourceWarnings);
    }

    // Catalog: record gone for missing IDs, upsert found products
    if (this.catalog) {
      try {
        const foundIds = new Set(hydrated.data.map((p) => p.id));
        for (const id of ids) {
          if (!foundIds.has(id)) {
            this.catalog.recordHydrationFailure(chain, id, 'gone');
          }
        }
        for (const product of hydrated.data) {
          this.catalog.upsertFromNormalizedProduct(product, 'web-discovery');
        }
      } catch (err) {
        logger.warn('Catalog upsert (web-search-discovery) failed:', err);
      }
    }

    const successfulCount = hydrated.data.filter((p) => passesFilterConstraints(p, filters)).length;
    // Deliverable 6: track hydration health
    this.recordHydrationHealth(chain, query, ids.length, successfulCount);

    // Deliverable 6: check if we need to force rediscovery
    const normalizedQuery = normalize(query);
    const cacheKey = `websearch:${this.provider.name}:${chain}:${normalizedQuery}`;
    await this.checkHydrationHealthAndMaybeRediscover(chain, config, cacheKey, query, normalizedQuery);

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

  private recordHydrationHealth(chain: Chain, query: string, total: number, succeeded: number): void {
    const key = `${chain}:${normalize(query)}`;
    const existing = this.hydrationHealth.get(key);
    if (existing) {
      existing.total += total;
      existing.succeeded += succeeded;
    } else {
      this.hydrationHealth.set(key, { total, succeeded });
    }
  }

  private async checkHydrationHealthAndMaybeRediscover(
    chain: Chain,
    config: WebSearchChainConfig,
    cacheKey: string,
    query: string,
    normalizedQuery: string,
  ): Promise<void> {
    const key = `${chain}:${normalizedQuery}`;
    const health = this.hydrationHealth.get(key);
    if (!health || health.total === 0) return;

    const successRate = health.succeeded / health.total;
    if (successRate >= 0.5) return;

    // Less than half hydrated successfully — invalidate and force rediscovery
    if (this.rediscoveryDone.has(cacheKey)) {
      return; // Already forced rediscovery this soft-TTL cycle — don't loop
    }

    this.rediscoveryDone.add(cacheKey);
    await this.cache.delete(cacheKey);

    // Re-run discovery (budget permitting — budget is checked at provider level)
    try {
      await this.discoverProductIds(chain, config, query);
    } catch {
      // Rediscovery failure is not fatal — we already have the degraded results
    }
  }

  private async discoverProductIds(
    chain: Chain,
    config: WebSearchChainConfig,
    query: string
  ): Promise<string[]> {
    const normalizedQuery = normalize(query);
    const cacheKey = `websearch:${this.provider.name}:${chain}:${normalizedQuery}`;
    const dedupKey = `${this.provider.name}:${chain}:${normalizedQuery}`;

    // In-flight dedup: if another caller is already fetching this key, reuse it.
    const existing = this.inFlight.get(dedupKey);
    if (existing !== undefined) {
      return existing;
    }

    const promise = this.doDiscoverProductIds(cacheKey, chain, config, query);
    this.inFlight.set(dedupKey, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(dedupKey);
    }
  }

  private async doDiscoverProductIds(
    cacheKey: string,
    chain: Chain,
    config: WebSearchChainConfig,
    query: string
  ): Promise<string[]> {
    const cached = await this.cache.get<CachedDiscoveryMapping>(cacheKey);

    if (cached) {
      if (cached.fresh || cached.needsRefresh) {
        // Fresh or soft-expired but still within hard TTL → return IDs.
        // Caller *could* refresh opportunistically when needsRefresh, but
        // for discovery the benefit is low — return as-is.
        return cached.data.ids;
      }
      // staleFallback: expiresAt ≤ now < staleUntil → we MUST attempt a
      // refresh below; if that fails, we fall back to stale data.
    }

    const maxProducts = config.maxProducts ?? this.maxProductsPerChain;
    let ids: string[];
    let searchSucceeded = false;
    try {
      const results = await this.provider.search(query, { site: config.site });
      searchSucceeded = true;
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
        if (ids.length >= maxProducts) break;
      }
    } catch (error) {
      // Provider failure — NOT cached as empty.
      if (cached?.staleFallback !== undefined) {
        // Serve the stale mapping rather than failing.
        return cached.staleFallback.ids;
      }
      throw error;
    }

    if (ids.length === 0) {
      if (searchSucceeded) {
        // Confirmed zero results → negative cache via emptySearch tier.
        await this.cache.set(
          cacheKey,
          { ids: [], emptyResult: true } satisfies CachedDiscoveryMapping,
          {
            provider: WEB_SEARCH_PROVIDER_LABEL,
            chain,
            sourceType: 'third-party',
            sourceUrl: undefined,
            confidence: 'medium',
          },
          EMPTY_SEARCH,
        );
      }
      return ids;
    }

    await this.cache.set(
      cacheKey,
      { ids } satisfies CachedDiscoveryMapping,
      {
        provider: WEB_SEARCH_PROVIDER_LABEL,
        chain,
        sourceType: 'third-party',
        sourceUrl: undefined,
        confidence: 'medium',
      },
      DISCOVERY,
    );

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
  catalog?: CatalogService;
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

  const cacheDirectory =
    options.cacheDirectory ??
    env.SWISS_SHOPPING_CACHE_DIR ??
    join(tmpdir(), 'swiss-shopping-mcp-cache');

  const cache = new FileTtlCache(cacheDirectory);
  cache.startPeriodicPrune();

  // Circuit breaker: 3 failures → open for 5 minutes
  const breaker = new SourceCircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 5 * 60_000,
  });

  // Budget tracker (persists across restarts)
  const budget = createProviderBudgetFromEnv(env, cacheDirectory);

  const provider = createWebSearchProviderFromEnv(env, options.fetchImpl, breaker, budget);
  if (!provider) {
    return undefined;
  }

  return new WebProductSearchService({
    provider,
    adapters,
    cache,
    catalog: options.catalog,
  });
}
