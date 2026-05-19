import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { AldiLiveAdapter } from './aldiLiveAdapter.js';

const cacheDirectories: string[] = [];

async function createCache(): Promise<FileTtlCache> {
  const directory = await mkdtemp(join(tmpdir(), 'swiss-shopping-mcp-aldi-live-'));
  cacheDirectories.push(directory);
  return new FileTtlCache(directory);
}

describe.skipIf(process.env.LIVE_SOURCE_TESTS !== '1')('AldiLiveAdapter live smoke', () => {
  afterEach(async () => {
    await Promise.all(cacheDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('searches Aldi live source for a known product page term', async () => {
    const adapter = new AldiLiveAdapter({ cache: await createCache() });

    const result = await adapter.searchProducts({ query: 'toskanabrot', limit: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0]).toMatchObject({
      chain: 'aldi',
      provenance: {
        provider: 'ALDI SUISSE',
        sourceType: 'retailer-web',
      },
    });
    expect(['live', 'cached', 'stale']).toContain(result.data[0].provenance?.freshness);
    expect(result.metadata?.sources?.[0].chain).toBe('aldi');
  }, 30_000);
});
