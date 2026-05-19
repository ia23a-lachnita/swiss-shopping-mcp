import {
  Chain,
  ChainAdapter,
  ComparisonBasis,
  NormalizedProduct,
  PriceComparisonFilters,
  Result,
  ResultMetadata,
} from '../adapters/types.js';
import { sourceWarningFromError } from '../sources/warnings.js';
import { getBaseUnitPrice } from '../util/units.js';

export interface ChainPriceOffer {
  chain: Chain;
  product: NormalizedProduct;
  unitPrice?: number;
  totalPrice: number;
  baseUnitPrice?: number;
  baseUnit?: string;
  comparisonPrice?: number;
  comparisonUnit?: string;
  comparisonEligible: boolean;
  isEligibleForUnitComparison: boolean;
  ineligibleReason?: string;
}

export interface PriceComparisonResult {
  query: string;
  quantity: number;
  offers: ChainPriceOffer[];
  cheapestOffer?: ChainPriceOffer;
  mostExpensiveOffer?: ChainPriceOffer;
  savingsVsMostExpensive?: number;
  comparisonBasis: ComparisonBasis;
  comparisonUnit?: string;
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function mergeMetadata(metadataEntries: ResultMetadata[], sourceWarnings: ResultMetadata['sourceWarnings']): ResultMetadata | undefined {
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

function createOffer(product: NormalizedProduct, quantity: number): ChainPriceOffer {
  const unitValue = product.price.unit?.value;
  const per = product.price.unit?.per;

  let unitPrice: number | undefined;
  let baseUnitPrice: number | undefined;
  let baseUnit: string | undefined;
  let isEligibleForUnitComparison = false;

  if (typeof unitValue === 'number' && unitValue > 0) {
    unitPrice = roundCurrency(product.price.current / unitValue);

    if (per) {
      const normalized = getBaseUnitPrice(product.price.current, unitValue, per);
      if (normalized) {
        baseUnitPrice = roundCurrency(normalized.price);
        baseUnit = normalized.unit;
        isEligibleForUnitComparison = true;
      }
    }
  }

  return {
    chain: product.chain,
    product,
    unitPrice,
    totalPrice: roundCurrency(product.price.current * quantity),
    baseUnitPrice,
    baseUnit,
    comparisonEligible: false,
    isEligibleForUnitComparison,
  };
}

function getPrimaryUnit(offers: ChainPriceOffer[]): string | undefined {
  const counts = new Map<string, number>();
  for (const offer of offers) {
    if (offer.baseUnit) {
      counts.set(offer.baseUnit, (counts.get(offer.baseUnit) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => {
      if (a[1] !== b[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .at(0)?.[0];
}

function prepareOffersForComparison(
  offers: ChainPriceOffer[],
  comparisonBasis: ComparisonBasis,
): { offers: ChainPriceOffer[]; comparisonUnit?: string } {
  if (comparisonBasis === 'packPrice') {
    return {
      offers: offers.map((offer) => ({
        ...offer,
        comparisonPrice: offer.totalPrice,
        comparisonUnit: 'pack',
        comparisonEligible: true,
      })),
      comparisonUnit: 'pack',
    };
  }

  const primaryUnit = getPrimaryUnit(offers);
  return {
    offers: offers.map((offer) => {
      if (!offer.baseUnit || offer.baseUnitPrice === undefined) {
        return {
          ...offer,
          comparisonEligible: false,
          isEligibleForUnitComparison: false,
          ineligibleReason: 'Missing normalized unit price.',
        };
      }

      if (primaryUnit && offer.baseUnit !== primaryUnit) {
        return {
          ...offer,
          comparisonEligible: false,
          isEligibleForUnitComparison: false,
          ineligibleReason: `Unit ${offer.baseUnit} is not comparable with ${primaryUnit}.`,
        };
      }

      return {
        ...offer,
        comparisonPrice: offer.baseUnitPrice,
        comparisonUnit: offer.baseUnit,
        comparisonEligible: true,
        isEligibleForUnitComparison: true,
      };
    }),
    comparisonUnit: primaryUnit,
  };
}

function sortOffers(a: ChainPriceOffer, b: ChainPriceOffer, comparisonBasis: ComparisonBasis): number {
  if (comparisonBasis === 'unitPrice') {
    if (a.comparisonEligible !== b.comparisonEligible) {
      return a.comparisonEligible ? -1 : 1;
    }

    if (a.comparisonEligible && b.comparisonEligible && a.comparisonPrice !== b.comparisonPrice) {
      return (a.comparisonPrice ?? 0) - (b.comparisonPrice ?? 0);
    }
  }

  if (a.totalPrice !== b.totalPrice) {
    return a.totalPrice - b.totalPrice;
  }
  return a.product.name.localeCompare(b.product.name);
}

export class PriceComparisonService {
  private readonly adapters: ChainAdapter[];

  public constructor(adapters: ChainAdapter[]) {
    this.adapters = adapters;
  }

  public async comparePrices(filters: PriceComparisonFilters): Promise<Result<PriceComparisonResult>> {
    const query = filters.query.trim();
    if (!query) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Query must be a non-empty string.' } };
    }

    const quantity = typeof filters.quantity === 'number' ? filters.quantity : 1;
    if (quantity <= 0) {
      return { ok: false, error: { code: 'INVALID_QUANTITY', message: 'Quantity must be greater than zero.' } };
    }

    const matchMode = filters.matchMode ?? 'balanced';
    const comparisonBasis = filters.comparisonBasis ?? 'packPrice';
    const requestedChains = new Set(filters.chains ?? this.adapters.map((adapter) => adapter.chain));
    const relevantAdapters = this.adapters.filter((adapter) => requestedChains.has(adapter.chain));
    if (relevantAdapters.length === 0) {
      return { ok: false, error: { code: 'CHAIN_NOT_SUPPORTED', message: 'No supported chains were requested.' } };
    }

    // Default to 1 candidate per chain unless specified otherwise.
    const limitPerChain = typeof filters.limitPerChain === 'number' ? filters.limitPerChain : 1;

    const perChainResults = await Promise.all(
      relevantAdapters.map(async (adapter) => {
        const productsResult = await adapter.searchProducts({
          query,
          maxPrice: filters.maxPrice,
          limit: limitPerChain,
          matchMode,
        });

        if (!productsResult.ok) {
          return { ok: false, chain: adapter.chain, error: productsResult.error } as const;
        }

        return { ok: true, chain: adapter.chain, products: productsResult.data, metadata: productsResult.metadata } as const;
      }),
    );

    const sourceWarnings = perChainResults
      .filter((chainResult) => !chainResult.ok)
      .map((chainResult) =>
        sourceWarningFromError(chainResult.chain, chainResult.ok ? { code: 'UNKNOWN' } : chainResult.error),
      );

    const successfulResults = perChainResults.filter((chainResult) => chainResult.ok);
    if (successfulResults.length === 0 && sourceWarnings.length > 0) {
      return {
        ok: false,
        error: {
          code: 'ALL_SOURCES_FAILED',
          message: sourceWarnings.map((warning) => `${warning.chain}: ${warning.message}`).join('; '),
        },
      };
    }

    const rawOffers = successfulResults
      .flatMap((chainResult) => (chainResult.ok ? chainResult.products : []))
      .map((product) => createOffer(product, quantity));

    const prepared = prepareOffersForComparison(rawOffers, comparisonBasis);
    const offers = prepared.offers.sort((a, b) => sortOffers(a, b, comparisonBasis));

    const cheapestOffer = offers.at(0);
    const eligibleForSavings =
      comparisonBasis === 'unitPrice' ? offers.filter((offer) => offer.comparisonEligible) : offers;
    const mostExpensiveOffer =
      eligibleForSavings.length > 0 ? eligibleForSavings[eligibleForSavings.length - 1] : undefined;

    let savingsVsMostExpensive: number | undefined;
    if (cheapestOffer && mostExpensiveOffer && cheapestOffer !== mostExpensiveOffer) {
      if (
        comparisonBasis === 'unitPrice' &&
        cheapestOffer.comparisonEligible &&
        mostExpensiveOffer.comparisonEligible &&
        cheapestOffer.comparisonUnit === mostExpensiveOffer.comparisonUnit
      ) {
        savingsVsMostExpensive = roundCurrency(
          (mostExpensiveOffer.comparisonPrice ?? 0) - (cheapestOffer.comparisonPrice ?? 0),
        );
      } else if (comparisonBasis === 'packPrice') {
        savingsVsMostExpensive = roundCurrency(mostExpensiveOffer.totalPrice - cheapestOffer.totalPrice);
      }
    }

    return {
      ok: true,
      data: {
        query,
        quantity,
        offers,
        cheapestOffer,
        mostExpensiveOffer,
        savingsVsMostExpensive,
        comparisonBasis,
        comparisonUnit: prepared.comparisonUnit,
      },
      metadata: mergeMetadata(
        successfulResults.flatMap((chainResult) =>
          chainResult.ok && chainResult.metadata ? [chainResult.metadata] : [],
        ),
        sourceWarnings,
      ),
    };
  }
}
