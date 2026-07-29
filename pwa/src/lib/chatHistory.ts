// Client-side chat history persistence (IndexedDB). Per
// docs/active/CHAT_AGENT_ARCHITECTURE_PLAN.md "Session / history state":
// the backend is stateless, so the PWA is the only place conversation
// history lives — one fixed record, no accounts/multi-conversation UI yet.
import type { UIMessage } from 'ai';

const DB_NAME = 'swiss-shopping-chat';
const STORE_NAME = 'history';
const RECORD_KEY = 'messages';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open chat history database.'));
  });
}

export async function loadChatHistory(): Promise<UIMessage[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(RECORD_KEY);
      request.onsuccess = () => resolve((request.result as UIMessage[] | undefined) ?? []);
      request.onerror = () => reject(request.error ?? new Error('Failed to read chat history.'));
    });
  } catch {
    // IndexedDB unavailable (private browsing, etc.) — chat still works, just without persisted history.
    return [];
  }
}

export async function saveChatHistory(messages: UIMessage[]): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(messages, RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to save chat history.'));
    });
  } catch {
    // Best-effort persistence — losing history is not fatal to the chat working.
  }
}

export async function clearChatHistory(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to clear chat history.'));
    });
  } catch {
    // No-op if IndexedDB is unavailable.
  }
}
