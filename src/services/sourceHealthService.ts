import {
  Chain,
  SourceProvenance,
  SourceStatus,
  SourceWarning,
  SourceWarningCode,
} from '../adapters/types.js';

export class SourceHealthService {
  private readonly statuses = new Map<Chain, SourceStatus>();

  public recordSuccess(chain: Chain, provenance: SourceProvenance): SourceStatus {
    const status: SourceStatus = {
      chain,
      status: provenance.freshness === 'live' ? 'live-beta' : 'degraded',
      provider: provenance.provider,
      sourceType: provenance.sourceType,
      lastObservedAt: provenance.observedAt,
    };
    this.statuses.set(chain, status);
    return status;
  }

  public recordWarning(chain: Chain, warning: SourceWarning): SourceStatus {
    const status: SourceStatus = {
      chain,
      status: warning.code === SourceWarningCode.RealSourceNotImplemented ? 'blocked' : 'degraded',
      provider: warning.provider,
      lastObservedAt: warning.observedAt,
      warning,
    };
    this.statuses.set(chain, status);
    return status;
  }

  public getStatus(chain: Chain): SourceStatus | undefined {
    return this.statuses.get(chain);
  }

  public listStatuses(chains?: Chain[]): SourceStatus[] {
    const requested = chains ? new Set(chains) : undefined;
    return Array.from(this.statuses.values())
      .filter((status) => requested === undefined || requested.has(status.chain))
      .sort((a, b) => a.chain.localeCompare(b.chain));
  }
}
