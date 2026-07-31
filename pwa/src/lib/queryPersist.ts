import type { QueryClient } from '@tanstack/react-query';

/**
 * Persists the react-query cache to IndexedDB.
 *
 * react-query's cache is memory-only, so a page refresh threw away every result
 * and refetched from scratch — which is most of why the app "felt like the cache
 * does nothing" even though the adapters cache for 6-24h. Restoring the cache
 * lets a repeated search paint immediately while any refetch happens behind it.
 *
 * Written by hand rather than pulling in @tanstack/react-query-persist-client +
 * idb-keyval: this needs ~60 lines and no new bytes on a bundle that already
 * code-splits the AI SDK to stay small.
 */
const DB_NAME = 'swiss-shopping-query-cache';
const STORE_NAME = 'queries';
const RECORD_KEY = 'cache';

/** Entries older than this are dropped on hydrate — stale prices are worse than a spinner. */
const MAX_AGE_MS = 15 * 60_000;
/** Guards against persisting an unbounded result history into IndexedDB. */
const MAX_ENTRIES = 40;
const WRITE_DEBOUNCE_MS = 1_000;

interface PersistedQuery {
  queryKey: unknown;
  data: unknown;
  updatedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open query cache database.'));
  });
}

async function read(): Promise<PersistedQuery[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(RECORD_KEY);
    request.onsuccess = () => resolve((request.result as PersistedQuery[] | undefined) ?? []);
    request.onerror = () => reject(request.error ?? new Error('Failed to read query cache.'));
  });
}

async function write(entries: PersistedQuery[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(entries, RECORD_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to write query cache.'));
  });
}

/**
 * Loads persisted results into `client`. Resolves even on failure — IndexedDB is
 * unavailable in some private-browsing modes, and the app must still work there,
 * just without the instant paint.
 */
export async function hydrateQueryCache(client: QueryClient): Promise<void> {
  try {
    const entries = await read();
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const entry of entries) {
      if (entry.updatedAt < cutoff) continue;
      // updatedAt is preserved so react-query still applies its own staleTime
      // and refetches behind the restored paint rather than trusting it forever.
      client.setQueryData(entry.queryKey as readonly unknown[], entry.data, {
        updatedAt: entry.updatedAt,
      });
    }
  } catch {
    // No persisted cache is a normal state, not an error.
  }
}

/** Subscribes to cache changes and mirrors successful results to IndexedDB. Returns an unsubscribe. */
export function persistQueryCache(client: QueryClient): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    const entries = client
      .getQueryCache()
      .getAll()
      .filter((query) => query.state.status === 'success' && query.state.data !== undefined)
      .map((query) => ({
        queryKey: query.queryKey,
        data: query.state.data,
        updatedAt: query.state.dataUpdatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_ENTRIES);

    void write(entries).catch(() => {
      // A failed write costs a slower next load, nothing more.
    });
  };

  const unsubscribe = client.getQueryCache().subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, WRITE_DEBOUNCE_MS);
  });

  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}
