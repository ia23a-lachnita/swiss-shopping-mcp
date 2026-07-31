import {
  Chain,
  ChainAdapter,
  MatchMode,
  NormalizedProduct,
  NormalizedPromotion,
  NormalizedStore,
  ProductAvailabilityResult,
  ProductSearchFilters,
  PromotionSearchFilters,
  Result,
  ResultMetadata,
  StoreAvailabilityByLocationFilters,
  StoreAvailabilitySupport,
  StoreProductAvailabilityFilters,
  StoreProductAvailabilityResult,
  StoreSearchFilters,
  StoreWithProductAvailability,
} from '../adapters/types.js';
import { sourceWarningFromError } from '../sources/warnings.js';
import { buildTaxonomy } from '../util/taxonomyBuilder.js';
import { resolveLocationAsync, distanceBetween } from '../util/geo.js';
import { raceWithTimeout, ADAPTER_SOFT_TIMEOUT_MS, chainTimeoutMs } from '../util/timeout.js';
import { ChainHealthBreaker } from './chainHealthBreaker.js';
import { SearchResultCache } from './searchResultCache.js';

/**
 * Soft deadline for the web-search augmentation step (semantic discovery
 * across multiple weak chains via SerpAPI/DuckDuckGo/etc). Discovered via
 * manual browser verification: unlike vendor adapters, this step had no
 * timeout at all — a slow/rate-limited search provider chain could hang the
 * entire search_products tool call indefinitely, well past its own
 * TOOL_TIMEOUT_MS backstop (see raceWithTimeout usage below). Wider than
 * ADAPTER_SOFT_TIMEOUT_MS since one call here can span several chains.
 */
const WEB_SEARCH_SOFT_TIMEOUT_MS = 8_000;
import { calculateMatchStrength, sortProducts } from '../util/matcher.js';
import { logger } from '../util/log.js';
import { CatalogService } from '../catalog/catalogService.js';
import { WebProductSearchService, WebProductSearchResult } from './webProductSearchService.js';
import { computeConfidence, type DiscoveryMethod } from '../catalog/provenance.js';
import { MetricsCollector } from '../util/metrics.js';

function sortStores(a: NormalizedStore, b: NormalizedStore): number {
  return a.name.localeCompare(b.name);
}

function promotionAsProduct(promotion: NormalizedPromotion): NormalizedProduct {
  return {
    id: promotion.id,
    chain: promotion.chain,
    name: promotion.productName ?? promotion.title,
    brand: promotion.brand,
    category: promotion.category,
    size: promotion.description,
    price: promotion.price ?? { current: Number.POSITIVE_INFINITY },
    tags: ['promotion'],
  };
}

function sortPromotions(
  a: NormalizedPromotion,
  b: NormalizedPromotion,
  query: string,
  matchMode: MatchMode,
  dynamicTaxonomy?: Record<string, string[]>,
): number {
  const strengthDiff =
    calculateMatchStrength(promotionAsProduct(b), query, matchMode, dynamicTaxonomy) -
    calculateMatchStrength(promotionAsProduct(a), query, matchMode, dynamicTaxonomy);
  if (strengthDiff !== 0) {
    return strengthDiff;
  }

  const aPrice = a.price?.current ?? Number.POSITIVE_INFINITY;
  const bPrice = b.price?.current ?? Number.POSITIVE_INFINITY;
  if (aPrice !== bPrice) {
    return aPrice - bPrice;
  }

  return a.title.localeCompare(b.title);
}

function mergeMetadata(
  metadataEntries: ResultMetadata[],
  sourceWarnings: ResultMetadata['sourceWarnings']
): ResultMetadata | undefined {
  const warnings = [
    ...metadataEntries.flatMap((metadata) => metadata.sourceWarnings ?? []),
    ...(sourceWarnings ?? []),
  ];
  const sources = metadataEntries.flatMap((metadata) => metadata.sources ?? []);
  const summary = metadataEntries
    .map((metadata) => metadata.summary)
    .filter((entry): entry is string => entry !== undefined)
    .join(' ');

  if (warnings.length === 0 && sources.length === 0 && !summary) {
    return undefined;
  }

  return {
    ...(warnings.length > 0 ? { sourceWarnings: warnings } : {}),
    ...(sources.length > 0 ? { sources } : {}),
    ...(summary ? { summary } : {}),
  };
}

function interleaveWebProducts(
  productsByChain: Map<Chain, NormalizedProduct[]>,
  chainOrder: Chain[]
): NormalizedProduct[] {
  const lists = chainOrder
    .filter((chain) => productsByChain.has(chain))
    .map((chain) => productsByChain.get(chain)!);
  const merged: NormalizedProduct[] = [];
  const maxLength = lists.reduce((max, list) => Math.max(max, list.length), 0);
  // Round-robin by web rank so a single chain cannot dominate the top results.
  for (let rank = 0; rank < maxLength; rank++) {
    for (const list of lists) {
      if (rank < list.length) {
        merged.push(list[rank]);
      }
    }
  }
  return merged;
}

export interface SearchServiceOptions {
  webProductSearch?: WebProductSearchService;
  /** Minimum share (0-1) of results with a price to skip web discovery. Default 0.8. */
  vendorPriceShareThreshold?: number;
  catalog?: CatalogService;
  /** Phase D: metrics collector for observability. */
  metrics?: MetricsCollector;
  /**
   * Skips chains that are currently failing, so a dead chain costs 0ms instead
   * of its whole timeout budget on every search. Omit to disable entirely —
   * callers that must always hit every chain (contract tests, one-off MCP
   * diagnostics) should leave it unset.
   */
  chainBreaker?: ChainHealthBreaker;
  /**
   * Whole-query stale-while-revalidate cache in front of the fan-out. Omit to
   * disable; `SearchService` never creates one implicitly, so a bare instance
   * stays fully deterministic for tests.
   */
  resultCache?: SearchResultCache;
}

/** Fired as each vendor adapter's search resolves, before web-search augmentation runs. */
export interface ChainProgressEvent {
  chain: Chain;
  ok: boolean;
  elapsedMs: number;
  respondedCount: number;
  totalCount: number;
  /** Cumulative product count across all chains that have responded ok so far. */
  productsSoFar: number;
}

export interface SearchProductsOptions {
  /** Called synchronously as each requested chain's vendor search resolves (parallel fan-out, so order is by real completion time, not request order). */
  onChainProgress?: (event: ChainProgressEvent) => void;
}

export class SearchService {
  private readonly adapters: ChainAdapter[];
  private readonly webProductSearch?: WebProductSearchService;
  private readonly vendorPriceShareThreshold: number;
  private readonly catalog?: CatalogService;
  private readonly metrics?: MetricsCollector;
  private readonly chainBreaker?: ChainHealthBreaker;
  private readonly resultCache?: SearchResultCache;

  public constructor(adapters: ChainAdapter[], options: SearchServiceOptions = {}) {
    this.adapters = adapters;
    this.webProductSearch = options.webProductSearch;
    this.vendorPriceShareThreshold = options.vendorPriceShareThreshold ?? 0.8;
    this.catalog = options.catalog;
    this.metrics = options.metrics;
    this.chainBreaker = options.chainBreaker;
    this.resultCache = options.resultCache;
  }

  /**
   * Whole-query cache in front of the fan-out (no-op unless a `resultCache` was
   * supplied). Fresh hits return immediately; stale hits also return immediately
   * and kick off one background refresh for the *next* caller.
   */
  public async searchProducts(
    filters: ProductSearchFilters,
    options: SearchProductsOptions = {}
  ): Promise<Result<NormalizedProduct[]>> {
    if (!this.resultCache) {
      return this.searchProductsUncached(filters, options);
    }

    const key = SearchResultCache.keyFor({
      query: filters.query,
      chains: filters.chains,
      maxPrice: filters.maxPrice,
      category: filters.category,
      limit: filters.limit,
      matchMode: filters.matchMode,
    });
    const hit = this.resultCache.get(key);

    if (hit.status !== 'miss') {
      if (hit.status === 'stale') {
        // Deliberately without onChainProgress: this call's stream has already
        // been answered from cache, and a background refresh writing progress
        // events into it would report chains for a search the caller never saw.
        this.resultCache.revalidate(key, async () => {
          const fresh = await this.runSearch(filters);
          if (fresh.result.ok) {
            this.resultCache?.set(
              key,
              { data: fresh.result.data, metadata: fresh.result.metadata },
              fresh.chainsComplete
            );
          }
        });
      }
      return { ok: true, data: hit.value.data, metadata: hit.value.metadata };
    }

    const { result, chainsComplete } = await this.runSearch(filters, options);
    if (result.ok) {
      this.resultCache.set(key, { data: result.data, metadata: result.metadata }, chainsComplete);
    }
    return result;
  }

  private async searchProductsUncached(
    filters: ProductSearchFilters,
    options: SearchProductsOptions = {}
  ): Promise<Result<NormalizedProduct[]>> {
    return (await this.runSearch(filters, options)).result;
  }

  /**
   * The real search. Reports `chainsComplete` alongside the result: true only if
   * every requested vendor chain answered ok. That is the *only* correct input
   * to the cache-or-not decision — warnings alone are not, since the optional
   * web-search step contributes its own and would veto caching almost always.
   */
  private async runSearch(
    filters: ProductSearchFilters,
    options: SearchProductsOptions = {}
  ): Promise<{ result: Result<NormalizedProduct[]>; chainsComplete: boolean }> {
    const query = filters.query.trim();
    if (!query) {
      return {
        result: {
          ok: false,
          error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' },
        },
        chainsComplete: false,
      };
    }

    const matchMode = filters.matchMode ?? 'balanced';
    const requestedChains = new Set(
      filters.chains ?? this.adapters.map((adapter) => adapter.chain)
    );
    const relevantAdapters = this.adapters.filter((adapter) => requestedChains.has(adapter.chain));
    if (relevantAdapters.length === 0) {
      return { result: { ok: true, data: [] }, chainsComplete: true };
    }

    const requestedChainList = [...requestedChains];
    const now = new Date().toISOString();

    // Step 1: Run vendor searches first to evaluate strength
    let respondedCount = 0;
    let productsSoFar = 0;
    const totalCount = relevantAdapters.length;
    const adapterResults = await Promise.all(
      relevantAdapters.map(async (adapter) => {
        const startMs = Date.now();
        const budgetMs = chainTimeoutMs(adapter.chain);

        // A chain the breaker has opened is skipped outright. This is the whole
        // point of the breaker: a reliably-dead chain used to burn its full
        // budget on every query, which set the floor for the entire search.
        const skipped = this.chainBreaker !== undefined && !this.chainBreaker.canAttempt(adapter.chain);
        const result = skipped
          ? ({
              ok: false,
              error: {
                code: 'SOURCE_CIRCUIT_OPEN',
                message: `${adapter.chain} is temporarily skipped after repeated failures.`,
              },
            } as Result<NormalizedProduct[]>)
          : await raceWithTimeout(
              () => adapter.searchProducts({ ...filters, query, matchMode }),
              budgetMs,
              () => ({
                ok: false,
                error: {
                  code: 'SOURCE_TIMEOUT',
                  message: `${adapter.chain} did not respond within ${budgetMs}ms.`,
                },
              } as Result<NormalizedProduct[]>)
            );
        const elapsedMs = Date.now() - startMs;
        // A skipped chain is not evidence about that chain's health, and its
        // 0ms "latency" would poison both the p75 ETA and the failure rate that
        // decides when to close the breaker again.
        if (!skipped) {
          this.chainBreaker?.record(adapter.chain, result.ok);
          if (this.metrics) {
            this.metrics.recordLatency(adapter.chain, elapsedMs);
            if (result.ok) {
              this.metrics.recordHydrationSuccess();
            } else {
              this.metrics.recordHydrationFailure();
            }
          }
        }
        respondedCount += 1;
        if (result.ok) productsSoFar += result.data.length;
        options.onChainProgress?.({
          chain: adapter.chain,
          ok: result.ok,
          elapsedMs,
          respondedCount,
          totalCount,
          // Clamped to the caller's limit so the live counter can never promise
          // more than the response will actually contain (reported: counter
          // climbed to 27, final list showed 12). This stays a safe lower bound
          // on the final count: nothing downstream removes vendor products —
          // web results are merged in additively and dedupe only collapses
          // pairs that were double-counted — so the only reduction is this very
          // limit. And since productsSoFar only grows, so does the clamped
          // value: the number never counts backwards.
          productsSoFar:
            typeof filters.limit === 'number'
              ? Math.min(productsSoFar, filters.limit)
              : productsSoFar,
        });
        return { chain: adapter.chain, result };
      })
    );

    const successfulResults = adapterResults.filter((entry) => entry.result.ok);
    // Every requested chain answered — the only condition under which this
    // result is safe to cache and replay to later callers.
    const chainsComplete = successfulResults.length === adapterResults.length;
    const vendorProducts = successfulResults.flatMap((entry) =>
      entry.result.ok ? entry.result.data : []
    );

    // Catalog: upsert successful vendor results (fire-and-forget)
    if (this.catalog) {
      try {
        for (const product of vendorProducts) {
          this.catalog.upsertFromNormalizedProduct(product, 'vendor-search');
        }
      } catch (err) {
        logger.warn('Catalog upsert failed after vendor search:', err);
      }
    }

    const sourceWarnings = adapterResults
      .filter((entry) => !entry.result.ok)
      .map((entry) =>
        sourceWarningFromError(
          entry.chain,
          entry.result.ok ? { code: 'UNKNOWN' } : entry.result.error
        )
      );

    // Step 2: Deliverable 4 — evaluate vendor strength to decide about web search
    const webSearchChains = this.shouldRunWebSearch(vendorProducts, requestedChainList);

    // Step 3: Run web search only if vendor results are weak, or only for weak chains
    let webResult: WebProductSearchResult | undefined;
    if (this.webProductSearch && webSearchChains.length > 0) {
      if (this.metrics) {
        this.metrics.recordWebSearch();
        this.metrics.recordWebSearchPerQuery(webSearchChains.length);
      }
      const webProductSearch = this.webProductSearch;
      try {
        webResult = await raceWithTimeout(
          () =>
            webProductSearch
              .searchProducts({ ...filters, query, matchMode }, webSearchChains)
              .catch(() => undefined),
          WEB_SEARCH_SOFT_TIMEOUT_MS,
          () => undefined
        );
      } catch {
        // Web search errors never fail the overall search
      }
    }

    if (webResult) {
      sourceWarnings.push(...webResult.warnings);
    }

    const webProducts = webResult ? interleaveWebProducts(webResult.productsByChain, requestedChainList) : [];

    if (successfulResults.length === 0 && webProducts.length === 0 && sourceWarnings.length > 0) {
      const metadata = mergeMetadata([], sourceWarnings);
      return { result: { ok: true, data: [], metadata }, chainsComplete: false };
    }

    // Build dynamic taxonomy from the product data
    const dynamicTaxonomy = buildTaxonomy([...vendorProducts, ...webProducts]);

    vendorProducts.sort((a, b) => sortProducts(a, b, query, matchMode, dynamicTaxonomy));

    // Merge: web-discovered products lead in engine-rank order (that ranking IS
    // the semantic signal), vendor-only products follow in match-strength order.
    // Duplicates keep the vendor copy (it may carry extra enrichment) at the
    // web-ranked position.
    let products: NormalizedProduct[];
    if (webProducts.length > 0) {
      const keyOf = (product: NormalizedProduct): string => `${product.chain}:${product.id}`;
      const vendorByKey = new Map(vendorProducts.map((product) => [keyOf(product), product]));
      const seen = new Set<string>();
      products = [];
      for (const webProduct of webProducts) {
        const key = keyOf(webProduct);
        if (seen.has(key)) continue;
        seen.add(key);
        const vendorCopy = vendorByKey.get(key);
        products.push(
          vendorCopy ? { ...vendorCopy, matchExplanation: webProduct.matchExplanation } : webProduct
        );
      }
      for (const vendorProduct of vendorProducts) {
        const key = keyOf(vendorProduct);
        if (seen.has(key)) continue;
        seen.add(key);
        products.push(vendorProduct);
      }
    } else {
      products = vendorProducts;
    }

    const metadataEntries = successfulResults.flatMap((entry) =>
      entry.result.ok && entry.result.metadata ? [entry.result.metadata] : []
    );

    // Catalog: search for additional results not returned by vendor search
    const catalogProductIds = new Set<string>();
    if (this.catalog) {
      try {
        const vendorKeySet = new Set(products.map((p) => `${p.chain}:${p.id}`));
        const catalogResults = this.catalog.search(query, { limit: (filters.limit ?? 20) * 2 });
        const catalogOnly = catalogResults
          .filter((r) => !vendorKeySet.has(`${r.product.chain}:${r.product.productId}`))
          .filter((r) => requestedChains.has(r.product.chain as Chain));

        if (catalogOnly.length > 0) {
          // Hydrate catalog-only hits via getProductsByIds (respecting Phase A/B caching)
          const byChain = new Map<Chain, string[]>();
          for (const hit of catalogOnly) {
            const chain = hit.product.chain;
            if (!byChain.has(chain)) byChain.set(chain, []);
            byChain.get(chain)!.push(hit.product.productId);
          }

          const hydratedProducts: NormalizedProduct[] = [];
          for (const [chain, ids] of byChain) {
            const adapter = this.adapters.find((a) => a.chain === chain);
            if (!adapter || typeof adapter.getProductsByIds !== 'function') continue;
            try {
              const result = await adapter.getProductsByIds(ids);
              if (result.ok) {
                hydratedProducts.push(...result.data);
                // Catalog: record 'gone' for IDs the adapter silently skipped
                const foundIds = new Set(result.data.map((p) => p.id));
                for (const id of ids) {
                  if (!foundIds.has(id)) {
                    try {
                      this.catalog.recordHydrationFailure(chain, id, 'gone');
                    } catch (err) {
                      logger.warn('Catalog recordHydrationFailure (catalog-hit gone) failed:', err);
                    }
                  }
                }
              } else {
                // Catalog: entire call failed — record 'transient' for all requested IDs
                for (const id of ids) {
                  try {
                    this.catalog.recordHydrationFailure(chain, id, 'transient');
                  } catch (err) {
                    logger.warn('Catalog recordHydrationFailure (catalog-hit transient) failed:', err);
                  }
                }
              }
            } catch {
              // Hydration failure for catalog hits is non-fatal
              // But still record transient for each ID
              for (const id of ids) {
                try {
                  this.catalog.recordHydrationFailure(chain, id, 'transient');
                } catch (err) {
                  logger.warn('Catalog recordHydrationFailure (catalog-hit exception transient) failed:', err);
                }
              }
            }
          }

          // Merge: catalog hits that got hydrated are appended
          for (const hydrated of hydratedProducts) {
            const key = `${hydrated.chain}:${hydrated.id}`;
            if (vendorKeySet.has(key)) continue;
            // Apply the same filters as vendor search
            if (typeof filters.maxPrice === 'number' && hydrated.price.current > filters.maxPrice) continue;
            products.push(hydrated);
            vendorKeySet.add(key);
            catalogProductIds.add(key);
          }

          if (hydratedProducts.length > 0) {
            metadataEntries.push({
              summary: `Results augmented with local catalog index (${hydratedProducts.length} additional products).`,
            });
          }
        }
      } catch (err) {
        logger.warn('Catalog search failed:', err);
      }
    }

    if (webResult && webResult.productsByChain.size > 0) {
      metadataEntries.push({
        summary: `Results augmented with semantic web search (${webResult.providerName}).`,
      });
    }

    // Phase D: Enrich every product with provenance + freshness metadata
    const webProductIds = new Set<string>();
    if (webResult) {
      for (const products of webResult.productsByChain.values()) {
        for (const p of products) {
          webProductIds.add(`${p.chain}:${p.id}`);
        }
      }
    }
    for (const product of products) {
      const key = `${product.chain}:${product.id}`;
      const isFromWeb = webProductIds.has(key);
      const isCatalogAugmented = catalogProductIds.has(key);

      const discoveredBy: DiscoveryMethod = isCatalogAugmented
        ? 'catalog'
        : isFromWeb
          ? 'web-google'
          : 'vendor';

      const confidence = computeConfidence({
        discoveredBy,
        stale: false,
        cacheFresh: false,
        cacheNeedsRefresh: false,
      });

      product._source = product.chain;
      product._discoveredBy = discoveredBy;
      product._observedAt = now;
      product._priceObservedAt = now;
      product._stale = false;
      product._confidence = confidence;
    }

    const metadata = mergeMetadata(metadataEntries, sourceWarnings);

    // Phase D: update catalog coverage metrics
    if (this.metrics && this.catalog) {
      try {
        const stats = this.catalog.stats();
        const pendingCount = this.catalog.getPendingObservationCount?.() ?? 0;
        this.metrics.updateCatalogCoverage({
          ...stats,
          pendingObservations: pendingCount,
        });
      } catch {
        // Metrics update is best-effort
      }
    }

    if (typeof filters.limit === 'number') {
      return {
        result: { ok: true, data: products.slice(0, filters.limit), metadata },
        chainsComplete,
      };
    }

    return { result: { ok: true, data: products, metadata }, chainsComplete };
  }

  /**
   * Deliverable 4: Evaluate vendor result strength and decide which chains
   * need web discovery augmentation.
   *
   * Returns the list of chains that should have web search run for them.
   * Empty array means vendor results are strong enough to skip web search entirely.
   */
  private shouldRunWebSearch(
    vendorProducts: NormalizedProduct[],
    requestedChains: Chain[],
  ): Chain[] {
    const countByChain = new Map<Chain, number>();
    for (const product of vendorProducts) {
      countByChain.set(product.chain, (countByChain.get(product.chain) ?? 0) + 1);
    }

    // Identify chains with weak or missing results
    const weakChains: Chain[] = [];
    for (const chain of requestedChains) {
      const chainCount = countByChain.get(chain) ?? 0;
      const chainProducts = vendorProducts.filter((p) => p.chain === chain);
      const chainPriceShare = chainCount > 0
        ? chainProducts.filter((p) => p.price.current > 0).length / chainCount
        : 0;

      if (chainCount < 3 || chainPriceShare < this.vendorPriceShareThreshold) {
        weakChains.push(chain);
      }
    }

    // If no chains are weak, skip web search entirely
    if (weakChains.length === 0) {
      return [];
    }

    return weakChains;
  }

  public async findStores(filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
    const location = filters.location.trim();
    if (!location) {
      return {
        ok: false,
        error: { code: 'INVALID_LOCATION', message: 'Location must be a non-empty string.' },
      };
    }

    const requestedChains = new Set(
      filters.chains ?? this.adapters.map((adapter) => adapter.chain)
    );
    const relevantAdapters = this.adapters.filter((adapter) => requestedChains.has(adapter.chain));
    if (relevantAdapters.length === 0) {
      return { ok: true, data: [] };
    }

    const adapterResults = await Promise.all(
      relevantAdapters.map(async (adapter) => ({
        chain: adapter.chain,
        result: await raceWithTimeout(
          () => adapter.findStores({ ...filters, location }),
          ADAPTER_SOFT_TIMEOUT_MS,
          () => ({
            ok: false,
            error: {
              code: 'SOURCE_TIMEOUT',
              message: `${adapter.chain} did not respond within ${ADAPTER_SOFT_TIMEOUT_MS}ms.`,
            },
          } as Result<NormalizedStore[]>)
        ),
      }))
    );

    const sourceWarnings = adapterResults
      .filter((entry) => !entry.result.ok)
      .map((entry) =>
        sourceWarningFromError(
          entry.chain,
          entry.result.ok ? { code: 'UNKNOWN' } : entry.result.error
        )
      );

    const successfulResults = adapterResults.filter((entry) => entry.result.ok);
    if (successfulResults.length === 0 && sourceWarnings.length > 0) {
      const metadata = mergeMetadata([], sourceWarnings);
      return { ok: true, data: [], metadata };
    }

    const metadata = mergeMetadata(
      successfulResults.flatMap((entry) =>
        entry.result.ok && entry.result.metadata ? [entry.result.metadata] : []
      ),
      sourceWarnings
    );

    if (typeof filters.limit === 'number') {
      // When limit is specified, allocate proportionally across chains
      // to prevent one chain from dominating results
      const chainCount = successfulResults.length;
      if (chainCount > 1) {
        const perChain = Math.max(1, Math.floor(filters.limit / chainCount));
        const stores: NormalizedStore[] = [];
        for (const entry of successfulResults) {
          if (entry.result.ok) {
            const chainStores = entry.result.data.slice(0, perChain);
            stores.push(...chainStores);
          }
        }
        stores.sort(sortStores);
        return { ok: true, data: stores.slice(0, filters.limit), metadata };
      }
    }

    const stores = successfulResults.flatMap((entry) => (entry.result.ok ? entry.result.data : []));
    stores.sort(sortStores);

    if (typeof filters.limit === 'number') {
      return { ok: true, data: stores.slice(0, filters.limit), metadata };
    }

    return { ok: true, data: stores, metadata };
  }

  public async searchPromotions(
    filters: PromotionSearchFilters
  ): Promise<Result<NormalizedPromotion[]>> {
    const query = filters.query.trim();
    if (!query) {
      return {
        ok: false,
        error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' },
      };
    }

    const matchMode = filters.matchMode ?? 'balanced';
    const requestedChains = new Set(
      filters.chains ?? this.adapters.map((adapter) => adapter.chain)
    );
    const relevantAdapters = this.adapters.filter((adapter) => requestedChains.has(adapter.chain));
    if (relevantAdapters.length === 0) {
      return { ok: true, data: [] };
    }

    const adapterResults = await Promise.all(
      relevantAdapters.map(async (adapter) => ({
        chain: adapter.chain,
        result: await raceWithTimeout(
          () => adapter.searchPromotions({ ...filters, query, matchMode }),
          ADAPTER_SOFT_TIMEOUT_MS,
          () => ({
            ok: false,
            error: {
              code: 'SOURCE_TIMEOUT',
              message: `${adapter.chain} did not respond within ${ADAPTER_SOFT_TIMEOUT_MS}ms.`,
            },
          } as Result<NormalizedPromotion[]>)
        ),
      }))
    );

    const sourceWarnings = adapterResults
      .filter((entry) => !entry.result.ok)
      .map((entry) =>
        sourceWarningFromError(
          entry.chain,
          entry.result.ok ? { code: 'UNKNOWN' } : entry.result.error
        )
      );

    const successfulResults = adapterResults.filter((entry) => entry.result.ok);
    if (successfulResults.length === 0 && sourceWarnings.length > 0) {
      const metadata = mergeMetadata([], sourceWarnings);
      return { ok: true, data: [], metadata };
    }

    const promotions = successfulResults.flatMap((entry) =>
      entry.result.ok ? entry.result.data : []
    );

    // Build dynamic taxonomy from promotion data (use productName as product proxy)
    const promoProducts = promotions.map((p) => promotionAsProduct(p));
    const dynamicTaxonomy = buildTaxonomy(promoProducts);

    promotions.sort((a, b) => sortPromotions(a, b, query, matchMode, dynamicTaxonomy));
    const metadata = mergeMetadata(
      successfulResults.flatMap((entry) =>
        entry.result.ok && entry.result.metadata ? [entry.result.metadata] : []
      ),
      sourceWarnings
    );

    if (typeof filters.limit === 'number') {
      return { ok: true, data: promotions.slice(0, filters.limit), metadata };
    }

    return { ok: true, data: promotions, metadata };
  }

  public getStoreAvailabilitySupport(chains?: Chain[]): StoreAvailabilitySupport[] {
    const requestedChains = new Set(chains ?? this.adapters.map((adapter) => adapter.chain));
    return this.adapters
      .filter((adapter) => requestedChains.has(adapter.chain))
      .map((adapter) => adapter.getStoreAvailabilitySupport())
      .sort((a, b) => a.chain.localeCompare(b.chain));
  }

  public async lookupStoreProductAvailability(
    chain: Chain,
    filters: StoreProductAvailabilityFilters
  ): Promise<Result<StoreProductAvailabilityResult>> {
    const adapter = this.adapters.find((candidate) => candidate.chain === chain);
    if (!adapter) {
      return {
        ok: false,
        error: { code: 'CHAIN_NOT_SUPPORTED', message: `Unsupported chain: ${chain}` },
      };
    }

    return adapter.lookupStoreProductAvailability(filters);
  }

  public async lookupAvailabilityByLocation(
    filters: StoreAvailabilityByLocationFilters
  ): Promise<Result<StoreWithProductAvailability[]>> {
    const query = filters.query.trim();
    const location = filters.location.trim();
    if (!query) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Query is required.' } };
    }
    if (!location) {
      return { ok: false, error: { code: 'INVALID_LOCATION', message: 'Location is required.' } };
    }

    const availabilityChains: Chain[] = filters.chains ?? (['migros', 'coop'] as Chain[]);
    const storeLimit = typeof filters.limit === 'number' ? filters.limit : 20;

    const storeResults = await this.findStores({
      location,
      chains: availabilityChains,
      limit: storeLimit,
    });

    if (!storeResults.ok) {
      return { ok: false, error: storeResults.error };
    }

    const stores = storeResults.data;
    const now = new Date();

    const availabilityChecks = await Promise.all(
      stores.map(async (store) => {
        const fallback = (): StoreWithProductAvailability => ({
          ...store,
          available: false,
          isOpen: this.isStoreOpen(store.openingHours, now),
        });
        try {
          const result = await raceWithTimeout(
            () =>
              this.lookupStoreProductAvailability(store.chain, {
                query,
                storeId: store.id,
              }),
            ADAPTER_SOFT_TIMEOUT_MS,
            () => ({
              ok: false,
              error: {
                code: 'SOURCE_TIMEOUT',
                message: `${store.chain} did not respond within ${ADAPTER_SOFT_TIMEOUT_MS}ms.`,
              },
            } as Result<StoreProductAvailabilityResult>)
          );
          if (result.ok && result.data.supported) {
            const isAvailable = result.data.isAvailable;
            const bestMatch = result.data.matches.find((m) => m.available) ?? result.data.matches[0];
            const stockCount = bestMatch && 'stockCount' in bestMatch ? (bestMatch as { stockCount?: number }).stockCount : undefined;
            return {
              ...store,
              available: isAvailable,
              stockCount,
              isOpen: this.isStoreOpen(store.openingHours, now),
            } as StoreWithProductAvailability;
          }
          return fallback();
        } catch {
          return fallback();
        }
      })
    );

    let filtered = availabilityChecks;
    if (filters.inStockOnly) {
      filtered = filtered.filter((s) => s.available);
    }
    if (filters.openNow) {
      filtered = filtered.filter((s) => s.isOpen !== false);
    }

    return { ok: true, data: filtered };
  }

  public async lookupAvailabilityByLocationProductsFirst(
    filters: StoreAvailabilityByLocationFilters
  ): Promise<Result<ProductAvailabilityResult[]>> {
    const query = filters.query.trim();
    const location = filters.location.trim();
    if (!query) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Query is required.' } };
    }
    if (!location) {
      return { ok: false, error: { code: 'INVALID_LOCATION', message: 'Location is required.' } };
    }

    // Search products per chain to guarantee all chains are represented
    const requestedChains = filters.chains ?? this.adapters.map((a) => a.chain);
    const perChainProducts = await Promise.all(
      requestedChains.map(async (chain) => {
        const result = await this.searchProducts({ query, chains: [chain], limit: 5 });
        if (!result.ok || result.data.length === 0) return [];
        return result.data;
      })
    );
    const representativeProducts = perChainProducts.flat();

    if (representativeProducts.length === 0) {
      return { ok: false, error: { code: 'NO_PRODUCTS', message: 'No products found for this query.' } };
    }

    const chainsNeeded = [...new Set(representativeProducts.map((p) => p.chain))];
    const storeLimit = typeof filters.limit === 'number' ? filters.limit : 10;
    const now = new Date();

    // Prefer the caller's raw device GPS position (e.g. browser geolocation)
    // over geocoding `location`, which only resolves to a postal-code
    // centroid — a coarser approximation of the user's actual position that
    // distance-based nearest-store ranking would otherwise be stuck with.
    let userLat: number | undefined = filters.latitude;
    let userLon: number | undefined = filters.longitude;
    if (userLat === undefined || userLon === undefined) {
      try {
        const userLoc = await resolveLocationAsync(location);
        if (userLoc) {
          userLat = userLoc.latitude;
          userLon = userLoc.longitude;
        }
      } catch {
        // Geocation is best-effort; adapters will fall back to their own logic
      }
    }

    // Fetch stores per chain SEQUENTIALLY to avoid API rate-limiting conflicts,
    // then check availability per representative product (not once per chain
    // reused across all its products) so each product's stores reflect that
    // exact product's own stock, not whichever product a shared, raw-text
    // vendor search happens to resolve to.
    const storesByProduct = new Map<NormalizedProduct, StoreWithProductAvailability[]>();

    for (const chain of chainsNeeded) {
      const storeResult = await this.findStores({
        location,
        chains: [chain],
        limit: storeLimit,
      });

      if (!storeResult.ok || storeResult.data.length === 0) continue;

      // Nearest-first: vendor APIs return stores in their own (often alphabetical)
      // order, not sorted by actual distance from the user.
      const orderedStores =
        userLat !== undefined && userLon !== undefined
          ? [...storeResult.data].sort((a, b) => {
              if (!a.location || !b.location) return 0;
              return (
                distanceBetween({ latitude: userLat!, longitude: userLon! }, a.location) -
                distanceBetween({ latitude: userLat!, longitude: userLon! }, b.location)
              );
            })
          : storeResult.data;

      const chainProducts = representativeProducts.filter((p) => p.chain === chain);

      for (const product of chainProducts) {
        const availabilityChecks = await Promise.all(
          orderedStores.map(async (store) => {
            const fallback = (): StoreWithProductAvailability => ({
              ...store,
              available: false,
              availabilitySupported: false,
              isOpen: this.isStoreOpen(store.openingHours, now),
            });
            try {
              const result = await raceWithTimeout(
                () =>
                  this.lookupStoreProductAvailability(chain as Chain, {
                    query,
                    product,
                    storeId: store.id,
                    storeLatitude: store.location?.latitude,
                    storeLongitude: store.location?.longitude,
                    userLatitude: userLat,
                    userLongitude: userLon,
                  }),
                ADAPTER_SOFT_TIMEOUT_MS,
                () => ({
                  ok: false,
                  error: {
                    code: 'SOURCE_TIMEOUT',
                    message: `${chain} did not respond within ${ADAPTER_SOFT_TIMEOUT_MS}ms.`,
                  },
                } as Result<StoreProductAvailabilityResult>)
              );
              if (result.ok && result.data.supported) {
                const storeMatch = result.data.matches.find((m) => m.storeId === store.id);
                return {
                  ...store,
                  available: storeMatch ? storeMatch.available : result.data.isAvailable,
                  stockCount: storeMatch && 'stockCount' in storeMatch ? (storeMatch as { stockCount?: number }).stockCount : undefined,
                  isOpen: this.isStoreOpen(store.openingHours, now),
                } as StoreWithProductAvailability;
              }
              return {
                ...store,
                available: false,
                availabilitySupported: false,
                availabilityReason: result.ok ? result.data.reason : undefined,
                isOpen: this.isStoreOpen(store.openingHours, now),
              } as StoreWithProductAvailability;
            } catch {
              return fallback();
            }
          })
        );

        storesByProduct.set(product, availabilityChecks);
      }
    }

    const results: ProductAvailabilityResult[] = representativeProducts.map((product) => ({
      product,
      stores: storesByProduct.get(product) ?? [],
    }));

    return { ok: true, data: results };
  }

  private isStoreOpen(openingHours: string | undefined, now: Date): boolean | undefined {
    if (!openingHours) return undefined;
    try {
      // Handle new structured format: "Mon-Fri: 08:00-19:00 | Sat-Sun: 09:00-17:00"
      if (openingHours.includes('Mon-Fri') || openingHours.includes('Sat-Sun')) {
        const currentDay = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
        const isWeekday = currentDay >= 1 && currentDay <= 5;
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();
        const timeNum = currentHour * 60 + currentMinute;

        // Parse the hours for today
        const sections = openingHours.split('|').map(s => s.trim());
        for (const section of sections) {
          const isWeekdaySection = section.startsWith('Mon-Fri');
          const isWeekendSection = section.startsWith('Sat-Sun');

          if ((isWeekday && isWeekdaySection) || (!isWeekday && isWeekendSection)) {
            // Extract time ranges from this section
            const timeRanges = section.replace(/^.*?:\s*/, '').split(',').map(t => t.trim());
            for (const range of timeRanges) {
              const match = range.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
              if (match) {
                const openNum = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
                const closeNum = parseInt(match[3], 10) * 60 + parseInt(match[4], 10);
                if (timeNum >= openNum && timeNum <= closeNum) {
                  return true;
                }
              }
            }
          }
        }
        return false;
      }

      // Handle Migros format: "2026-06-19 08:00" (date + opening time, no closing time)
      const dateMatch = openingHours.match(/^\d{4}-\d{2}-\d{2}\s+(\d{1,2}):(\d{2})$/);
      if (dateMatch) {
        // Migros format: only opening time, no closing time - can't determine if open
        return undefined;
      }

      // Handle Coop format: "07:30 - 20:00" (opening - closing)
      const hourMatch = openingHours.match(/(\d{1,2}):(\d{2})/);
      if (!hourMatch) return undefined;
      const hour = parseInt(hourMatch[1], 10);
      const minute = parseInt(hourMatch[2], 10);
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();
      const timeNum = currentHour * 60 + currentMinute;
      const openNum = hour * 60 + minute;

      const closeMatch = openingHours.match(/-?\s*(\d{1,2}):(\d{2})/g);
      if (closeMatch && closeMatch.length >= 1) {
        const lastClose = closeMatch[closeMatch.length - 1];
        const closeTimeMatch = lastClose.match(/(\d{1,2}):(\d{2})/);
        if (closeTimeMatch) {
          const closeHour = parseInt(closeTimeMatch[1], 10);
          const closeMinute = parseInt(closeTimeMatch[2], 10);
          const closeNum = closeHour * 60 + closeMinute;
          return timeNum >= openNum && timeNum <= closeNum;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
}
