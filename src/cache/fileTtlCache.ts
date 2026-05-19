import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SourceProvenance } from '../adapters/types.js';

export interface CacheClock {
  now(): Date;
}

export interface CacheRecord<T> {
  key: string;
  data: T;
  provenance: SourceProvenance;
  observedAt: string;
  expiresAt: string;
}

export interface CacheHit<T> {
  data: T;
  provenance: SourceProvenance;
  observedAt: string;
  expiresAt: string;
  isStale: boolean;
}

interface StoredCacheRecord {
  key: string;
  data: unknown;
  provenance: SourceProvenance;
  observedAt: string;
  expiresAt: string;
}

const systemClock: CacheClock = {
  now: (): Date => new Date(),
};

function cacheFileName(key: string): string {
  return `${createHash('sha256').update(key).digest('hex')}.json`;
}

export class FileTtlCache {
  private readonly directory: string;
  private readonly clock: CacheClock;

  public constructor(directory: string, clock: CacheClock = systemClock) {
    this.directory = directory;
    this.clock = clock;
  }

  public async get<T>(key: string, options?: { allowStale?: boolean }): Promise<CacheHit<T> | undefined> {
    const record = await this.readRecord<T>(key);
    if (!record) {
      return undefined;
    }

    const expiresAtMs = Date.parse(record.expiresAt);
    const isStale = expiresAtMs <= this.clock.now().getTime();
    if (isStale && options?.allowStale !== true) {
      await this.delete(key);
      return undefined;
    }

    return {
      data: record.data,
      observedAt: record.observedAt,
      expiresAt: record.expiresAt,
      isStale,
      provenance: {
        ...record.provenance,
        freshness: isStale ? 'stale' : 'cached',
        cacheExpiresAt: record.expiresAt,
      },
    };
  }

  public async set<T>(
    key: string,
    data: T,
    provenance: Omit<SourceProvenance, 'observedAt' | 'freshness' | 'cacheExpiresAt'>,
    ttlMs: number,
  ): Promise<CacheRecord<T>> {
    if (ttlMs <= 0) {
      throw new Error('Cache TTL must be greater than zero.');
    }

    const observedAt = this.clock.now();
    const expiresAt = new Date(observedAt.getTime() + ttlMs);
    const record: CacheRecord<T> = {
      key,
      data,
      observedAt: observedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      provenance: {
        ...provenance,
        observedAt: observedAt.toISOString(),
        freshness: 'cached',
        cacheExpiresAt: expiresAt.toISOString(),
      },
    };

    await mkdir(this.directory, { recursive: true });
    const target = this.getPath(key);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(record), 'utf8');
    await rename(temporary, target);
    return record;
  }

  public async delete(key: string): Promise<void> {
    try {
      await unlink(this.getPath(key));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

  private getPath(key: string): string {
    return join(this.directory, cacheFileName(key));
  }

  private async readRecord<T>(key: string): Promise<CacheRecord<T> | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.getPath(key), 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }

    const parsed = JSON.parse(raw) as StoredCacheRecord;
    if (parsed.key !== key) {
      throw new Error(`Cache key mismatch for ${key}.`);
    }

    return {
      key: parsed.key,
      data: parsed.data as T,
      provenance: parsed.provenance,
      observedAt: parsed.observedAt,
      expiresAt: parsed.expiresAt,
    };
  }
}
