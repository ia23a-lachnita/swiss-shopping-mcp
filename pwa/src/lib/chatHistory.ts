// Client-side chat history persistence (IndexedDB). Per
// docs/active/CHAT_AGENT_ARCHITECTURE_PLAN.md "Session / history state":
// the backend is stateless, so the PWA is the only place conversation
// history lives.
//
// v2 (2026-08-06) turns the single fixed `history/'messages'` record into a
// `conversations` store, one record per thread, newest first. Written by hand
// rather than pulling in `idb`, matching `queryPersist.ts` — same reason, the
// bundle already code-splits the AI SDK to stay small.
import type { UIMessage } from 'ai';

const DB_NAME = 'swiss-shopping-chat';
const DB_VERSION = 2;

/**
 * The v1 store. Kept in v2 rather than deleted: it still holds the *global*
 * `activeLocation`, and its pre-v2 `'messages'` record is deliberately left in
 * place as the only copy of history that predates the migration.
 */
const LEGACY_STORE = 'history';
const LEGACY_MESSAGES_KEY = 'messages';
const ACTIVE_LOCATION_KEY = 'activeLocation';

const CONVERSATIONS_STORE = 'conversations';
const UPDATED_AT_INDEX = 'updatedAt';

/**
 * `indexedDB.open()` can hang indefinitely on iOS Safari after a cold start
 * without ever firing `success` or `error` (WebKit #226547). The chat renders a
 * skeleton until history loads, so an unbounded wait is a permanently blank
 * tab; bound it and degrade to "no persistence" instead.
 */
const OPEN_TIMEOUT_MS = 4_000;

/**
 * `listConversations` reads whole records — IndexedDB has no projection, so a
 * summary costs the messages too. Bounding the store bounds that read, the same
 * way `queryPersist.ts` bounds its cache at 40 entries.
 */
const MAX_CONVERSATIONS = 50;

const MAX_TITLE_LENGTH = 60;
const UNTITLED = 'Neue Unterhaltung';

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: UIMessage[];
}

/** What the history sheet lists — the same record without its messages. */
export type ConversationSummary = Omit<Conversation, 'messages'> & { messageCount: number };

/**
 * `crypto.randomUUID` is only defined in a secure context, and this PWA is
 * routinely opened over plain http from a phone on the LAN while testing, where
 * it is `undefined` and would throw.
 */
export function newConversationId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Auto-title: the first user message, which is what the thread is about. */
export function titleFromMessages(messages: UIMessage[]): string {
  const first = messages.find((message) => message.role === 'user');
  const text = (first?.parts ?? [])
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return UNTITLED;
  return text.length <= MAX_TITLE_LENGTH ? text : `${text.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

/**
 * Schema + data migration, run inside the `versionchange` transaction so the
 * two commit or roll back together (IndexedDB spec §3.1.7: an abort reverts the
 * schema, the data *and* the version bump).
 *
 * Strictly synchronous IDB callbacks, no `await`: a transaction auto-commits at
 * the microtask checkpoint once no request is pending, so awaiting a non-IDB
 * promise mid-upgrade closes the transaction under us and the next request
 * throws `InvalidStateError`.
 */
function upgrade(db: IDBDatabase, tx: IDBTransaction, oldVersion: number): void {
  if (oldVersion < 1) {
    db.createObjectStore(LEGACY_STORE);
  }
  if (oldVersion < 2) {
    const conversations = db.createObjectStore(CONVERSATIONS_STORE, { keyPath: 'id' });
    conversations.createIndex(UPDATED_AT_INDEX, UPDATED_AT_INDEX);

    // A fresh install has no v1 record to carry over.
    if (oldVersion >= 1) {
      const request = tx.objectStore(LEGACY_STORE).get(LEGACY_MESSAGES_KEY);
      request.onsuccess = () => {
        const messages = request.result as UIMessage[] | undefined;
        if (!Array.isArray(messages) || messages.length === 0) return;
        const now = Date.now();
        conversations.put({
          id: newConversationId(),
          title: titleFromMessages(messages),
          createdAt: now,
          updatedAt: now,
          messages,
        } satisfies Conversation);
      };
    }
  }
}

/**
 * One shared connection. The previous version opened a new one per call and
 * never closed any of them, which is what makes a version bump dangerous: a
 * still-open v1 connection blocks `open(name, 2)` indefinitely, and with no
 * `blocked` handler the promise never settles.
 */
let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error('IndexedDB did not answer open() in time.'))),
      OPEN_TIMEOUT_MS
    );

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const tx = request.transaction;
      // The spec guarantees a versionchange transaction here; without it there
      // is no atomic way to migrate, so fail rather than half-upgrade.
      if (!tx) throw new Error('Missing versionchange transaction during upgrade.');
      upgrade(request.result, tx, event.oldVersion);
    };

    // Another tab still holds an older version open. Rejecting degrades to "no
    // persistence"; waiting would hang the chat behind its loading skeleton.
    request.onblocked = () =>
      finish(() => reject(new Error('A different tab is holding an older chat database open.')));

    request.onsuccess = () => {
      const db = request.result;
      // Do not block a future upgrade from another tab — and drop the cached
      // connection so the next call reopens at the new version.
      db.onversionchange = () => {
        db.close();
        dbPromise = undefined;
      };
      db.onclose = () => {
        dbPromise = undefined;
      };
      if (settled) {
        // We already gave up (timeout or blocked); do not leak the connection.
        db.close();
        return;
      }
      finish(() => resolve(db));
    };

    request.onerror = () =>
      finish(() => reject(request.error ?? new Error('Failed to open chat history database.')));
  });

  // A failure must not be cached forever — a private-browsing denial or a
  // transient blocked state would otherwise disable persistence for the page's
  // whole lifetime.
  dbPromise = pending;
  pending.catch(() => {
    if (dbPromise === pending) dbPromise = undefined;
  });
  return pending;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

/** Newest first. Resolves to `[]` when IndexedDB is unavailable. */
export async function listConversations(): Promise<ConversationSummary[]> {
  try {
    const db = await openDb();
    const tx = db.transaction(CONVERSATIONS_STORE, 'readonly');
    const all = (await promisify(
      tx.objectStore(CONVERSATIONS_STORE).index(UPDATED_AT_INDEX).getAll()
    )) as Conversation[];
    return all
      .map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messageCount: conversation.messages.length,
      }))
      .reverse();
  } catch {
    return [];
  }
}

export async function loadConversation(id: string): Promise<Conversation | undefined> {
  try {
    const db = await openDb();
    const tx = db.transaction(CONVERSATIONS_STORE, 'readonly');
    return (await promisify(tx.objectStore(CONVERSATIONS_STORE).get(id))) as Conversation | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Drops the oldest conversations past `MAX_CONVERSATIONS`, in its own
 * transaction rather than sharing the write's.
 *
 * Deliberately not atomic with the put: chaining a second request off an
 * awaited one inside a single transaction relies on the microtask running
 * before auto-commit, which holds in modern browsers but is the exact subtlety
 * `idb` exists to hide. A surviving extra record until the next save is a
 * non-consequence; an `InvalidStateError` losing the message that was being
 * written is not. Keys only — `getAllKeys` on the index does not deserialise
 * the message arrays.
 */
async function prune(db: IDBDatabase): Promise<void> {
  const readTx = db.transaction(CONVERSATIONS_STORE, 'readonly');
  const keys = await promisify(readTx.objectStore(CONVERSATIONS_STORE).index(UPDATED_AT_INDEX).getAllKeys());
  if (keys.length <= MAX_CONVERSATIONS) return;

  const tx = db.transaction(CONVERSATIONS_STORE, 'readwrite');
  const store = tx.objectStore(CONVERSATIONS_STORE);
  for (const key of keys.slice(0, keys.length - MAX_CONVERSATIONS)) {
    store.delete(key);
  }
  await committed(tx);
}

/**
 * Writes one conversation, then prunes. Best-effort: losing a write costs
 * history, not a working chat.
 */
export async function saveConversation(conversation: Conversation): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(CONVERSATIONS_STORE, 'readwrite');
    tx.objectStore(CONVERSATIONS_STORE).put(conversation);
    await committed(tx);
    await prune(db);
  } catch {
    // Best-effort persistence — losing history is not fatal to the chat working.
  }
}

export async function deleteConversation(id: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(CONVERSATIONS_STORE, 'readwrite');
    tx.objectStore(CONVERSATIONS_STORE).delete(id);
    await committed(tx);
  } catch {
    // No-op if IndexedDB is unavailable.
  }
}

/**
 * Chat-scoped location context, set by the `set_chat_location` tool once the
 * agent learns the user's location. Deliberately **global** rather than stored
 * per conversation: where the shopper is, is a fact about the shopper, not
 * about one thread, and scoping it per thread would silently revert the active
 * location when they opened an older conversation.
 *
 * Still separate from `AvailabilityView`'s own location `useState` — no
 * cross-tab sharing.
 */
export async function loadActiveLocation(): Promise<string | undefined> {
  try {
    const db = await openDb();
    const tx = db.transaction(LEGACY_STORE, 'readonly');
    return (await promisify(tx.objectStore(LEGACY_STORE).get(ACTIVE_LOCATION_KEY))) as string | undefined;
  } catch {
    return undefined;
  }
}

export async function saveActiveLocation(location: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(LEGACY_STORE, 'readwrite');
    tx.objectStore(LEGACY_STORE).put(location, ACTIVE_LOCATION_KEY);
    await committed(tx);
  } catch {
    // Best-effort persistence — losing it just means the agent asks again.
  }
}

/**
 * Asks the browser to exempt this origin from storage eviction. WebKit's ITP
 * purges all script-writeable storage — IndexedDB included — after 7 days
 * without a visit unless the PWA is installed to the Home Screen, which would
 * silently delete the entire chat history. Advisory: browsers may refuse, and
 * that is not an error worth surfacing.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
