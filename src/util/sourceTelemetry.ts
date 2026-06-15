import { Chain, SourceCapability, SourceWarningCode } from '../adapters/types.js';
import { logger } from './log.js';

export type SourceAttemptOutcome = 'success' | 'warning' | 'error';
export type CacheOutcome = 'hit' | 'miss' | 'stale' | 'none';

export interface SourceAttemptEvent {
  provider: string;
  chain: Chain;
  capability: SourceCapability;
  sourceUrl?: string;
  elapsedMs: number;
  outcome: SourceAttemptOutcome;
  warningCode?: SourceWarningCode;
  cache: CacheOutcome;
}

export function logSourceAttempt(event: SourceAttemptEvent): void {
  const entry = {
    provider: event.provider,
    chain: event.chain,
    capability: event.capability,
    elapsedMs: event.elapsedMs,
    outcome: event.outcome,
    cache: event.cache,
    ...(event.warningCode ? { warningCode: event.warningCode } : {}),
    ...(event.sourceUrl ? { sourceUrl: event.sourceUrl } : {}),
  };

  if (event.outcome === 'error') {
    logger.error('source-attempt', entry);
  } else if (event.outcome === 'warning') {
    logger.warn('source-attempt', entry);
  } else {
    logger.info('source-attempt', entry);
  }
}
