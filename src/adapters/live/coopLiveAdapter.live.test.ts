import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { SourceHttpClient } from '../../sources/sourceClient.js';
import { CoopLiveAdapter } from './coopLiveAdapter.js';

const cacheDirectories: string[] = [];

async function createCache(): Promise<FileTtlCache> {
  const directory = await mkdtemp(join(tmpdir(), 'swiss-shopping-mcp-coop-live-'));
  cacheDirectories.push(directory);
  return new FileTtlCache(directory);
}

describe.skipIf(process.env.LIVE_SOURCE_TESTS !== '1')('CoopLiveAdapter live smoke', () => {
  afterEach(async () => {
    await Promise.all(cacheDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('searches Coop live source for a known product term', async () => {
    const adapter = new CoopLiveAdapter({
      cache: await createCache(),
      sourceClient: new SourceHttpClient({ rateLimitPerHostMs: 1_000 }),
    });

    const result = await adapter.searchProducts({ query: 'milch', limit: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0]).toMatchObject({
      chain: 'coop',
      provenance: {
        provider: 'Coop',
        sourceType: 'retailer-web',
      },
    });
    expect(['live', 'cached', 'stale']).toContain(result.data[0].provenance?.freshness);
  }, 30_000);

  it('finds Coop stores near Zürich', async () => {
    const adapter = new CoopLiveAdapter({
      cache: await createCache(),
      sourceClient: new SourceHttpClient({ rateLimitPerHostMs: 1_000 }),
    });

    const result = await adapter.findStores({ location: 'Zürich', limit: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0].chain).toBe('coop');
  }, 30_000);
});
