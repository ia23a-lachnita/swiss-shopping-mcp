import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { SourceHttpClient } from '../../sources/sourceClient.js';
import { UnsupportedChainAdapter } from '../unsupportedAdapter.js';
import { DennerPromotionsAdapter } from './dennerPromotionsAdapter.js';

const cacheDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    cacheDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe.skipIf(!process.env.LIVE_SOURCE_TESTS)(
  'DennerPromotionsAdapter live smoke test',
  () => {
    it('fetches real Denner promotions and parses at least one result', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'swiss-shopping-mcp-denner-live-'));
      cacheDirectories.push(directory);

      const adapter = new DennerPromotionsAdapter({
        delegate: new UnsupportedChainAdapter('denner', {}),
        cache: new FileTtlCache(directory),
        sourceClient: new SourceHttpClient({ rateLimitPerHostMs: 1_000 }),
        cacheTtlMs: 60_000,
      });

      const result = await adapter.searchPromotions({ query: 'aktion' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBeGreaterThan(0);
        expect(result.data[0].provenance?.sourceType).toBe('retailer-web');
        expect(result.data[0].provenance?.freshness).toBe('live');
      }
    }, 30_000);
  }
);
