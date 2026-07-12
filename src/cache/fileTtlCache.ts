import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SourceProvenance } from '../adapters/types.js';
import { logger } from '../util/log.js';
import { FreshnessTier, computeTtlBoundaries } from './freshnessPolicy.js';

export interface CacheClock {
  now(): Date;
}

export interface CacheRecord<T> {
  key: string;
  data: T;
  provenance: SourceProvenance;
  observedAt: string;
  refreshAfter: string;
  expiresAt: string;
  staleUntil: string;
}

/**
 * Result returned by the cache read path.
 *
 * - `fresh: true`                — now < refreshAfter → caller uses value as-is.
 * - `needsRefresh: true`         — refreshAfter ≤ now < expiresAt → value is
 *   usable but caller should refresh opportunistically.
 * - `staleFallback` present      — expiresAt ≤ now < staleUntil → caller must
 *   attempt refresh; only on provider failure may it fall back to this value.
 * - `undefined`                  — now ≥ staleUntil or record missing → miss.
 *
 * Backward-compat: `isStale` is a derived boolean (true when !fresh) for
 * legacy callers that only checked stale vs. not-stale.
 */
export interface CacheHit<T> {
  data: T;
  provenance: SourceProvenance;
  observedAt: string;
  refreshAfter: string;
  expiresAt: string;
  staleUntil: string;
  fresh: boolean;
  needsRefresh: boolean;
  staleFallback: T | undefined;
  /** @deprecated Use `fresh`/`needsRefresh`/`staleFallback` instead. */
  isStale: boolean;
}

export interface CacheStats {
  entryCount: number;
  totalBytes: number;
}

interface StoredCacheRecord {
  key: string;
  data: unknown;
  provenance: SourceProvenance;
  observedAt: string;
  /** May be absent in legacy records (written before Phase A). */
  refreshAfter?: string;
  expiresAt: string;
  /** May be absent in legacy records. */
  staleUntil?: string;
}

const systemClock: CacheClock = {
  now: (): Date => new Date(),
};

function cacheFileName(key: string): string {
  return `${createHash('sha256').update(key).digest('hex')}.json`;
}

function normalizeRecord(record: StoredCacheRecord): {
  refreshAfter: string;
  expiresAt: string;
  staleUntil: string;
} {
  const expiresAtMs = Date.parse(record.expiresAt);
  // Legacy records: refreshAfter = expiresAt, staleUntil = expiresAt
  const refreshAfterMs = record.refreshAfter !== undefined
    ? Date.parse(record.refreshAfter)
    : expiresAtMs;
  const staleUntilMs = record.staleUntil !== undefined
    ? Date.parse(record.staleUntil)
    : expiresAtMs;
  return {
    refreshAfter: new Date(refreshAfterMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    staleUntil: new Date(staleUntilMs).toISOString(),
  };
}

const DEFAULT_MAX_FILES = 5_000;

export class FileTtlCache {
  private readonly directory: string;
  private readonly clock: CacheClock;
  private readonly maxFiles: number;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;

  public constructor(directory: string, clock: CacheClock = systemClock, maxFiles?: number) {
    this.directory = directory;
    this.clock = clock;
    this.maxFiles = maxFiles ?? (parseInt(process.env.SWISS_SHOPPING_CACHE_MAX_FILES ?? '', 10) || DEFAULT_MAX_FILES);
  }

  /**
   * Start periodic pruning (hourly). Timer is unref'd so it does not keep the
   * process alive. Also runs one immediate prune.
   */
  public startPeriodicPrune(): void {
    this.prune().catch((error: unknown) => {
      logger.debug('Cache prune failed', error);
    });
    if (this.pruneTimer === undefined) {
      this.pruneTimer = setInterval(() => {
        this.prune().catch((error: unknown) => {
          logger.debug('Cache prune failed', error);
        });
      }, 60 * 60 * 1_000);
      this.pruneTimer.unref();
    }
  }

  /** Stop the periodic prune timer (for tests / graceful shutdown). */
  public stopPeriodicPrune(): void {
    if (this.pruneTimer !== undefined) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
  }

  /**
   * Read a cache entry.
   *
   * Backward-compat overload: `get(key, { allowStale: true })` returns the
   * old-style hit where `isStale` is the primary indicator (true when
   * now >= expiresAt, same as the old single-boundary behavior).
   */
  public async get<T>(key: string, options?: { allowStale?: boolean }): Promise<CacheHit<T> | undefined> {
    const record = await this.readRecord<T>(key);
    if (!record) {
      return undefined;
    }

    const nowMs = this.clock.now().getTime();
    const boundaries = normalizeRecord(record);
    const refreshAfterMs = Date.parse(boundaries.refreshAfter);
    const expiresAtMs = Date.parse(boundaries.expiresAt);
    const staleUntilMs = Date.parse(boundaries.staleUntil);

    // Old `isStale` semantics: true when now >= expiresAt
    const isStale = nowMs >= expiresAtMs;
    // Whether there is a genuine stale window (staleUntil > expiresAt)
    const hasStaleWindow = staleUntilMs > expiresAtMs;

    if (isStale && !hasStaleWindow && options?.allowStale !== true) {
      // Past hard expiry with no stale window (legacy record or tier without
      // stale fallback) and caller did not request stale → delete and miss.
      await this.delete(key);
      return undefined;
    }

    if (hasStaleWindow && nowMs >= staleUntilMs) {
      // Past the emergency window → always delete, always miss.
      await this.delete(key);
      return undefined;
    }

    if (nowMs < refreshAfterMs) {
      // Fresh — now < soft TTL
      return {
        data: record.data as T,
        observedAt: record.observedAt,
        ...boundaries,
        fresh: true,
        needsRefresh: false,
        staleFallback: undefined,
        isStale: false,
        provenance: {
          ...record.provenance,
          freshness: 'cached',
          cacheExpiresAt: boundaries.expiresAt,
        },
      };
    }

    if (nowMs < expiresAtMs) {
      // Soft-expired but within hard TTL — usable, caller may refresh
      return {
        data: record.data as T,
        observedAt: record.observedAt,
        ...boundaries,
        fresh: false,
        needsRefresh: true,
        staleFallback: undefined,
        isStale: false,
        provenance: {
          ...record.provenance,
          freshness: 'cached',
          cacheExpiresAt: boundaries.expiresAt,
        },
      };
    }

    // expiresAt ≤ now < staleUntil → stale fallback (only reached when allowStale: true)
    return {
      data: record.data as T,
      observedAt: record.observedAt,
      ...boundaries,
      fresh: false,
      needsRefresh: true,
      staleFallback: record.data as T,
      isStale: true,
      provenance: {
        ...record.provenance,
        freshness: 'stale',
        cacheExpiresAt: boundaries.expiresAt,
      },
    };
  }

  /**
   * Tier-based set: uses a FreshnessTier to compute soft/hard/stale boundaries.
   */
  public async set<T>(
    key: string,
    data: T,
    provenance: Omit<SourceProvenance, 'observedAt' | 'freshness' | 'cacheExpiresAt'>,
    tierOrTtlMs: FreshnessTier | number,
  ): Promise<CacheRecord<T>> {
    const observedAt = this.clock.now();
    let refreshAfter: Date;
    let expiresAt: Date;
    let staleUntil: Date;

    if (typeof tierOrTtlMs === 'number') {
      // Legacy raw-TTL mode: soft=hard, stale=hard (old behavior)
      if (tierOrTtlMs <= 0) {
        throw new Error('Cache TTL must be greater than zero.');
      }
      expiresAt = new Date(observedAt.getTime() + tierOrTtlMs);
      refreshAfter = expiresAt;
      staleUntil = expiresAt;
    } else {
      const boundaries = computeTtlBoundaries(tierOrTtlMs, observedAt);
      refreshAfter = boundaries.refreshAfter;
      expiresAt = boundaries.expiresAt;
      staleUntil = boundaries.staleUntil;
    }
    const record: CacheRecord<T> = {
      key,
      data,
      observedAt: observedAt.toISOString(),
      refreshAfter: refreshAfter.toISOString(),
      expiresAt: expiresAt.toISOString(),
      staleUntil: staleUntil.toISOString(),
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

  /**
   * Delete records past staleUntil (or past expiresAt for legacy records) and
   * enforce a max file count via LRU eviction (mtime as last-access proxy).
   */
  public async prune(): Promise<CacheStats> {
    await mkdir(this.directory, { recursive: true });
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch {
      return { entryCount: 0, totalBytes: 0 };
    }

    const nowMs = this.clock.now().getTime();
    let totalBytes = 0;
    const fileInfos: Array<{ name: string; mtimeMs: number; size: number }> = [];

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const filePath = join(this.directory, entry);
      try {
        const fileInfo = await stat(filePath);
        totalBytes += fileInfo.size;
        fileInfos.push({ name: entry, mtimeMs: fileInfo.mtimeMs, size: fileInfo.size });

        // Try to parse and check staleness
        let raw: string;
        try {
          raw = await readFile(filePath, 'utf8');
        } catch {
          continue;
        }
        const parsed = JSON.parse(raw) as StoredCacheRecord;
        const boundaries = normalizeRecord(parsed);
        const staleUntilMs = Date.parse(boundaries.staleUntil);
        if (nowMs >= staleUntilMs) {
          try {
            await unlink(filePath);
            totalBytes -= fileInfo.size;
          } catch {
            // File may have been removed concurrently
          }
        }
      } catch {
        // Individual file errors (corrupt JSON, permission issues) are logged
        // at debug level and skipped — they should not abort the entire prune.
      }
    }

    // Re-read after deletions to get accurate count for LRU eviction
    let survivingEntries: string[];
    try {
      survivingEntries = await readdir(this.directory);
    } catch {
      return { entryCount: 0, totalBytes: 0 };
    }

    const survivingJsons = survivingEntries.filter((e) => e.endsWith('.json'));
    if (survivingJsons.length <= this.maxFiles) {
      return { entryCount: survivingJsons.length, totalBytes };
    }

    // LRU eviction: sort by mtime ascending (oldest first) and remove excess
    const survivingInfos: Array<{ name: string; mtimeMs: number; size: number }> = [];
    let survivingBytes = 0;
    for (const name of survivingJsons) {
      try {
        const info = await stat(join(this.directory, name));
        survivingInfos.push({ name, mtimeMs: info.mtimeMs, size: info.size });
        survivingBytes += info.size;
      } catch {
        // Gone between readdir and stat — skip
      }
    }

    survivingInfos.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const toRemove = survivingInfos.length - this.maxFiles;
    for (let i = 0; i < toRemove; i++) {
      const victim = survivingInfos[i];
      try {
        await unlink(join(this.directory, victim.name));
        survivingBytes -= victim.size;
      } catch {
        // Gone concurrently — skip
      }
    }

    return {
      entryCount: Math.max(0, survivingInfos.length - toRemove),
      totalBytes: Math.max(0, survivingBytes),
    };
  }

  /** Get current cache stats without pruning. */
  public async stats(): Promise<CacheStats> {
    await mkdir(this.directory, { recursive: true });
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch {
      return { entryCount: 0, totalBytes: 0 };
    }

    let totalBytes = 0;
    let count = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const info = await stat(join(this.directory, entry));
        totalBytes += info.size;
        count++;
      } catch {
        // Skip
      }
    }
    return { entryCount: count, totalBytes };
  }

  private getPath(key: string): string {
    return join(this.directory, cacheFileName(key));
  }

  private async readRecord<T>(key: string): Promise<StoredCacheRecord & { data: T } | undefined> {
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

    // Touch the file to update mtime for LRU tracking (best-effort)
    try {
      const filePath = this.getPath(key);
      const now = this.clock.now();
      const { utimes } = await import('node:fs/promises');
      await utimes(filePath, now, now);
    } catch {
      // atime/mtime touch is best-effort; missing it only affects LRU accuracy
    }

    return parsed as StoredCacheRecord & { data: T };
  }
}
