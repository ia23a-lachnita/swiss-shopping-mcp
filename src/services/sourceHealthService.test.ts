import { describe, expect, it } from 'vitest';

import { SourceWarningCode } from '../adapters/types.js';
import { SourceHealthService } from './sourceHealthService.js';

describe('SourceHealthService', () => {
  it('records successful live source observations', () => {
    const service = new SourceHealthService();

    const status = service.recordSuccess('migros', {
      provider: 'Migros',
      chain: 'migros',
      sourceType: 'retailer-web',
      sourceUrl: 'https://example.test',
      observedAt: '2026-05-18T10:00:00.000Z',
      freshness: 'live',
      confidence: 'medium',
    });

    expect(status).toMatchObject({
      chain: 'migros',
      status: 'live-beta',
      provider: 'Migros',
      lastObservedAt: '2026-05-18T10:00:00.000Z',
    });
    expect(service.getStatus('migros')).toEqual(status);
  });

  it('records blocked and degraded warning states', () => {
    const service = new SourceHealthService();

    const blocked = service.recordWarning('coop', {
      chain: 'coop',
      code: SourceWarningCode.RealSourceNotImplemented,
      message: 'No acceptable source yet.',
    });
    const degraded = service.recordWarning('aldi', {
      chain: 'aldi',
      code: SourceWarningCode.SourceUnavailable,
      message: 'Source unavailable.',
    });

    expect(blocked.status).toBe('blocked');
    expect(degraded.status).toBe('degraded');
    expect(service.listStatuses().map((status) => status.chain)).toEqual(['aldi', 'coop']);
  });
});
