import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { LidlLiveAdapter } from './lidlLiveAdapter.js';

const cacheDirectories: string[] = [];

async function createCache(): Promise<FileTtlCache> {
  const directory = await mkdtemp(join(tmpdir(), 'swiss-shopping-mcp-lidl-live-'));
  cacheDirectories.push(directory);
  return new FileTtlCache(directory);
}

describe.skipIf(process.env.LIVE_SOURCE_TESTS !== '1')('LidlLiveAdapter live smoke', () => {
  afterEach(async () => {
    await Promise.all(cacheDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('searches Lidl live source for a known product term', async () => {
    const adapter = new LidlLiveAdapter({
      cache: await createCache(),
    });

    const result = await adapter.searchProducts({ query: 'milch', limit: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.metadata).toBeDefined();
    expect(result.metadata?.sources?.[0]?.chain).toBe('lidl');
  }, 30_000);

  it('finds Lidl stores near Zürich', async () => {
    const adapter = new LidlLiveAdapter({
      cache: await createCache(),
    });

    const result = await adapter.findStores({ location: 'Zürich', limit: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0].chain).toBe('lidl');
  }, 30_000);
});
