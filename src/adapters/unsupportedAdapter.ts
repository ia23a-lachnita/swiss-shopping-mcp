import {
  Chain,
  ChainAdapter,
  NormalizedProduct,
  NormalizedPromotion,
  NormalizedStore,
  ProductSearchFilters,
  PromotionSearchFilters,
  Result,
  SourceCapability,
  SourceWarningCode,
  StoreAvailabilitySupport,
  StoreProductAvailabilityFilters,
  StoreProductAvailabilityResult,
  StoreSearchFilters,
} from './types.js';

const SUPPORTED_HINT =
  'Call get_source_status for current chain support. Current source-backed capabilities are Denner promotions and constrained Aldi product search.';

export class UnsupportedChainAdapter implements ChainAdapter {
  public readonly chain: Chain;
  private readonly reasons: Partial<Record<SourceCapability, string>>;

  public constructor(chain: Chain, reasons: Partial<Record<SourceCapability, string>> = {}) {
    this.chain = chain;
    this.reasons = reasons;
  }

  public async searchProducts(_filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
    return this.notImplemented('productSearch');
  }

  public async searchPromotions(
    _filters: PromotionSearchFilters
  ): Promise<Result<NormalizedPromotion[]>> {
    return this.notImplemented('promotions');
  }

  public async findStores(_filters: StoreSearchFilters): Promise<Result<NormalizedStore[]>> {
    return this.notImplemented('storeSearch');
  }

  public getStoreAvailabilitySupport(): StoreAvailabilitySupport {
    return {
      chain: this.chain,
      supported: false,
      reason: this.reason('availability'),
    };
  }

  public async lookupStoreProductAvailability(
    filters: StoreProductAvailabilityFilters
  ): Promise<Result<StoreProductAvailabilityResult>> {
    return {
      ok: true,
      data: {
        chain: this.chain,
        storeId: filters.storeId,
        query: filters.query,
        supported: false,
        reason: this.reason('availability'),
        matches: [],
        isAvailable: false,
      },
    };
  }

  private reason(capability: SourceCapability): string {
    return (
      this.reasons[capability] ??
      `${this.chain} ${capability} is not backed by a real source.`
    );
  }

  private notImplemented(capability: SourceCapability): Result<never> {
    const reason = this.reason(capability);
    return {
      ok: false,
      error: {
        code: SourceWarningCode.RealSourceNotImplemented,
        message: `${this.chain} ${capability} is unsupported: ${reason} ${SUPPORTED_HINT}`,
      },
    };
  }
}
