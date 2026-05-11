import {
  Chain,
  ChainAdapter,
  NormalizedProduct,
  PriceComparisonFilters,
  Result,
} from '../adapters/types.js';

export interface ChainPriceOffer {
  chain: Chain;
  product: NormalizedProduct;
  unitPrice?: number;
  totalPrice: number;
}

export interface PriceComparisonResult {
  query: string;
  quantity: number;
  offers: ChainPriceOffer[];
  cheapestOffer?: ChainPriceOffer;
  mostExpensiveOffer?: ChainPriceOffer;
  savingsVsMostExpensive?: number;
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function createOffer(product: NormalizedProduct, quantity: number): ChainPriceOffer {
  const unitValue = product.price.unit?.value;
  const unitPrice =
    typeof unitValue === 'number' && unitValue > 0
      ? roundCurrency(product.price.current / unitValue)
      : undefined;

  return {
    chain: product.chain,
    product,
    unitPrice,
    totalPrice: roundCurrency(product.price.current * quantity),
  };
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

    const requestedChains = new Set(filters.chains ?? this.adapters.map((adapter) => adapter.chain));
    const relevantAdapters = this.adapters.filter((adapter) => requestedChains.has(adapter.chain));
    const limitPerChain = typeof filters.limitPerChain === 'number' ? filters.limitPerChain : 10;

    const perChainResults = await Promise.all(
      relevantAdapters.map(async (adapter) => {
        const productsResult = await adapter.searchProducts({
          query,
          maxPrice: filters.maxPrice,
          limit: limitPerChain,
        });

        if (!productsResult.ok) {
          return { ok: false, chain: adapter.chain, error: productsResult.error } as const;
        }

        return { ok: true, chain: adapter.chain, products: productsResult.data } as const;
      }),
    );

    for (const chainResult of perChainResults) {
      if (!chainResult.ok) {
        return {
          ok: false,
          error: {
            code: `CHAIN_${chainResult.chain.toUpperCase()}_${chainResult.error.code}`,
            message: chainResult.error.message,
          },
        };
      }
    }

    const offers = perChainResults
      .flatMap((chainResult) => (chainResult.ok ? chainResult.products.slice(0, 1) : []))
      .map((product) => createOffer(product, quantity))
      .sort((a, b) => {
        if (a.totalPrice !== b.totalPrice) {
          return a.totalPrice - b.totalPrice;
        }
        return a.product.name.localeCompare(b.product.name);
      });

    const cheapestOffer = offers.at(0);
    const mostExpensiveOffer = offers.length > 0 ? offers[offers.length - 1] : undefined;
    const savingsVsMostExpensive =
      cheapestOffer && mostExpensiveOffer
        ? roundCurrency(mostExpensiveOffer.totalPrice - cheapestOffer.totalPrice)
        : undefined;

    return {
      ok: true,
      data: {
        query,
        quantity,
        offers,
        cheapestOffer,
        mostExpensiveOffer,
        savingsVsMostExpensive,
      },
    };
  }
}
