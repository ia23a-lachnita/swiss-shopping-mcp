import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { VolgLiveAdapter } from './volgLiveAdapter.js';

const cacheDirectories: string[] = [];

async function createCache(): Promise<FileTtlCache> {
  const directory = await mkdtemp(join(tmpdir(), 'swiss-shopping-mcp-volg-contract-'));
  cacheDirectories.push(directory);
  return new FileTtlCache(directory);
}

describe.skipIf(process.env.RUN_CONTRACT_TESTS !== '1')('Volg contract', () => {
  afterEach(async () => {
    await Promise.all(
      cacheDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it('search endpoint returns valid JSON with products', async () => {
    const adapter = new VolgLiveAdapter({ cache: await createCache() });
    const result = await adapter.searchProducts({ query: 'milch', limit: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0]).toHaveProperty('chain', 'volg');
    expect(result.data[0]).toHaveProperty('name');
    expect(result.data[0]).toHaveProperty('price');
    expect(result.data[0].price).toHaveProperty('current');
  }, 10_000);

  it('findStores returns empty (delivery-only service)', async () => {
    const adapter = new VolgLiveAdapter({ cache: await createCache() });
    const result = await adapter.findStores({ location: 'Zürich', limit: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data.length).toBe(0);
  }, 10_000);
});
