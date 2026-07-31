import { NormalizedProduct, ResultMetadata } from '../adapters/types.js';

/**
 * In-process stale-while-revalidate cache for whole product-search results.
 *
 * The adapters already cache (6-24h TTL, real short-circuit), but that only
 * saves the vendor round trip — the fan-out still ran `Promise.all` over every
 * chain's soft timeout on every single query, so a repeat search cost the same
 * as a cold one and caching looked broken from the outside. This sits in front
 * of the fan-out, so an identical query inside the fresh window costs ~0ms.
 *
 * Two rules matter more than the TTLs:
 *
 *  1. **Partial results are never stored.** Caching a set that is missing a
 *     failed chain would propagate that one failure to every later hit for the
 *     whole stale window — turning a transient blip into sticky wrong data.
 *  2. **Stale is served, then refreshed in the background.** Returning stale
 *     immediately is the entire point; the refresh replaces the entry for the
 *     *next* caller, never blocks this one, and never surfaces its errors.
 */
export interface CachedSearchResult {
  data: NormalizedProduct[];
  metadata?: ResultMetadata;
}

interface CacheEntry extends CachedSearchResult {
  storedAt: number;
}

export interface SearchResultCacheOptions {
  /** Within this age, a hit is returned as-is with no refresh. */
  freshMs?: number;
  /** Beyond `freshMs` but within this, a hit is returned *and* refreshed in the background. */
  staleMs?: number;
  /** Cap on distinct cached queries (oldest evicted first). */
  maxEntries?: number;
  clock?: { now(): number };
}

export type SearchCacheHit =
  | { status: 'miss' }
  | { status: 'fresh'; value: CachedSearchResult }
  | { status: 'stale'; value: CachedSearchResult };

export class SearchResultCache {
  private readonly freshMs: number;
  private readonly staleMs: number;
  private readonly maxEntries: number;
  private readonly clock: { now(): number };
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlightRefreshes = new Set<string>();

  public constructor(options: SearchResultCacheOptions = {}) {
    this.freshMs = options.freshMs ?? 120_000;
    this.staleMs = options.staleMs ?? 900_000;
    this.maxEntries = options.maxEntries ?? 200;
    this.clock = options.clock ?? { now: (): number => Date.now() };
  }

  /**
   * Stable key for a search. Query is case/whitespace-normalised and the chain
   * list is sorted, so `milch [coop,migros]` and `Milch  [migros,coop]` share an
   * entry — otherwise chain-checkbox order alone would fragment the cache.
   */
  public static keyFor(parts: {
    query: string;
    chains?: string[];
    maxPrice?: number;
    category?: string;
    limit?: number;
    matchMode?: string;
  }): string {
    return JSON.stringify({
      q: parts.query.trim().toLowerCase().replace(/\s+/g, ' '),
      c: parts.chains ? [...parts.chains].sort() : null,
      p: parts.maxPrice ?? null,
      g: parts.category ?? null,
      l: parts.limit ?? null,
      m: parts.matchMode ?? null,
    });
  }

  public get(key: string): SearchCacheHit {
    const entry = this.entries.get(key);
    if (!entry) return { status: 'miss' };

    const age = this.clock.now() - entry.storedAt;
    const value = { data: entry.data, metadata: entry.metadata };

    if (age < this.freshMs) return { status: 'fresh', value };
    if (age < this.staleMs) return { status: 'stale', value };

    this.entries.delete(key);
    return { status: 'miss' };
  }

  /**
   * Stores a result, unless `complete` is false. See rule 1 above.
   *
   * Completeness is the caller's call, deliberately: only `SearchService` knows
   * whether every *requested vendor chain* answered. An earlier version of this
   * decided for itself by checking whether `metadata.sourceWarnings` was empty,
   * which live testing showed to be wrong in both directions — the optional
   * web-search augmentation step emits warnings of its own (and does so most of
   * the time), so that test rejected essentially every result and the cache
   * never populated at all.
   */
  public set(key: string, value: CachedSearchResult, complete: boolean): boolean {
    if (!complete) return false;

    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      // Map preserves insertion order, so the first key is the oldest write.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }

    this.entries.set(key, {
      data: value.data,
      metadata: value.metadata,
      storedAt: this.clock.now(),
    });
    return true;
  }

  /**
   * Runs `refresh` once per key at a time. Deduplicates concurrent revalidations
   * so a burst of stale hits triggers one background search, not N.
   */
  public revalidate(key: string, refresh: () => Promise<void>): void {
    if (this.inFlightRefreshes.has(key)) return;
    this.inFlightRefreshes.add(key);
    void refresh()
      .catch(() => {
        // A failed background refresh must never surface: the caller already
        // has its stale answer, and the entry simply ages out on its own.
      })
      .finally(() => {
        this.inFlightRefreshes.delete(key);
      });
  }

  public clear(): void {
    this.entries.clear();
  }

  public get size(): number {
    return this.entries.size;
  }
}
