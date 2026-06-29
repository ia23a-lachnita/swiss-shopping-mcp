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
import { calculateMatchStrength, sortProducts } from '../util/matcher.js';

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

export class SearchService {
  private readonly adapters: ChainAdapter[];

  public constructor(adapters: ChainAdapter[]) {
    this.adapters = adapters;
  }

  public async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
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
        result: await adapter.searchProducts({ ...filters, query, matchMode }),
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

    const products = successfulResults.flatMap((entry) =>
      entry.result.ok ? entry.result.data : []
    );

    // Build dynamic taxonomy from the product data
    const dynamicTaxonomy = buildTaxonomy(products);

    products.sort((a, b) => sortProducts(a, b, query, matchMode, dynamicTaxonomy));
    const metadata = mergeMetadata(
      successfulResults.flatMap((entry) =>
        entry.result.ok && entry.result.metadata ? [entry.result.metadata] : []
      ),
      sourceWarnings
    );

    if (typeof filters.limit === 'number') {
      return { ok: true, data: products.slice(0, filters.limit), metadata };
    }

    return { ok: true, data: products, metadata };
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
        result: await adapter.findStores({ ...filters, location }),
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
        result: await adapter.searchPromotions({ ...filters, query, matchMode }),
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
        try {
          const result = await this.lookupStoreProductAvailability(store.chain, {
            query,
            storeId: store.id,
          });
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
          return {
            ...store,
            available: false,
            isOpen: this.isStoreOpen(store.openingHours, now),
          } as StoreWithProductAvailability;
        } catch {
          return {
            ...store,
            available: false,
            isOpen: this.isStoreOpen(store.openingHours, now),
          } as StoreWithProductAvailability;
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

    // Search for products first
    const productResult = await this.searchProducts({
      query,
      chains: filters.chains,
      limit: 10,
    });

    if (!productResult.ok || productResult.data.length === 0) {
      return { ok: false, error: { code: 'NO_PRODUCTS', message: 'No products found for this query.' } };
    }

    const chainsNeeded = [...new Set(productResult.data.map((p) => p.chain))];
    const storeLimit = typeof filters.limit === 'number' ? filters.limit : 10;
    const now = new Date();

    // Fetch stores per chain SEQUENTIALLY to avoid API rate-limiting conflicts
    const allStoresWithAvail: StoreWithProductAvailability[] = [];

    for (const chain of chainsNeeded) {
      const storeResult = await this.findStores({
        location,
        chains: [chain],
        limit: storeLimit,
      });

      if (!storeResult.ok || storeResult.data.length === 0) continue;

      const availabilityChecks = await Promise.all(
        storeResult.data.map(async (store) => {
          try {
            const result = await this.lookupStoreProductAvailability(chain as Chain, {
              query,
              storeId: store.id,
              storeLatitude: store.location?.latitude,
              storeLongitude: store.location?.longitude,
            });
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
            return {
              ...store,
              available: false,
              availabilitySupported: false,
              isOpen: this.isStoreOpen(store.openingHours, now),
            } as StoreWithProductAvailability;
          }
        })
      );

      allStoresWithAvail.push(...availabilityChecks);
    }

    // Map each product to stores from its own chain
    const results: ProductAvailabilityResult[] = productResult.data.map((product) => ({
      product,
      stores: allStoresWithAvail.filter((s) => s.chain === product.chain),
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
