import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { FileTtlCache } from '../../cache/fileTtlCache.js';
import { LidlLiveAdapter } from './lidlLiveAdapter.js';

const cacheDirectories: string[] = [];

async function createCache(): Promise<FileTtlCache> {
  const directory = await mkdtemp(join(tmpdir(), 'swiss-shopping-mcp-lidl-contract-'));
  cacheDirectories.push(directory);
  return new FileTtlCache(directory);
}

describe.skipIf(process.env.RUN_CONTRACT_TESTS !== '1')('Lidl contract', () => {
  afterEach(async () => {
    await Promise.all(
      cacheDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it('search endpoint returns valid response (may be empty — Lidl API only exposes campaign metadata, not individual products)', async () => {
    const adapter = new LidlLiveAdapter({ cache: await createCache() });
    const result = await adapter.searchProducts({ query: 'milch', limit: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.isArray(result.data)).toBe(true);
    // Lidl campaigns API returns campaign metadata only, not product items
    // This is a known limitation documented in sourceRegistry.ts
  }, 10_000);

  it('store endpoint returns valid JSON with stores', async () => {
    const adapter = new LidlLiveAdapter({ cache: await createCache() });
    const result = await adapter.findStores({ location: 'Zürich', limit: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0]).toHaveProperty('chain', 'lidl');
    expect(result.data[0]).toHaveProperty('name');
    expect(result.data[0]).toHaveProperty('id');
  }, 10_000);
});
