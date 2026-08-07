import { test, expect, type Page } from '@playwright/test';

/**
 * Multi-conversation chat history (PWA_UX_FIX_PLAN_2026-07-30 §2.11).
 *
 * Driven through a real browser rather than a jsdom unit test on purpose: the
 * thing most likely to break is the IndexedDB v1 -> v2 upgrade, and a fake
 * IndexedDB would be testing the fake's idea of a `versionchange` transaction.
 * Everything here is seeded directly into IndexedDB, so no model is called and
 * nothing depends on a vendor being up.
 */

const ORIGIN = 'http://localhost:3000';
const APP = `${ORIGIN}/app?tab=chat`;
const DB_NAME = 'swiss-shopping-chat';

interface SeedConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Array<{ id: string; role: string; parts: Array<{ type: string; text: string }> }>;
}

function message(id: string, role: 'user' | 'assistant', text: string) {
  return { id, role, parts: [{ type: 'text', text }] };
}

/**
 * Seeds from the legacy SPA page at `/`, which shares the origin (and therefore
 * the database) with `/app` but never loads the PWA bundle — so the seed is not
 * racing the app's own upgrade.
 */
async function gotoSeedPage(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    (name) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => resolve();
      }),
    DB_NAME
  );
}

/** Writes the pre-v2 shape: one `history` store, one fixed `'messages'` record. */
async function seedLegacyHistory(page: Page): Promise<void> {
  await page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('history');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('history', 'readwrite');
      tx.objectStore('history').put(
        [
          { id: 'legacy-u1', role: 'user', parts: [{ type: 'text', text: 'Wo ist Bio-Reis am günstigsten?' }] },
          { id: 'legacy-a1', role: 'assistant', parts: [{ type: 'text', text: 'Bei Denner für CHF 2.95.' }] },
        ],
        'messages'
      );
      tx.objectStore('history').put('Zürich', 'activeLocation');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, DB_NAME);
}

/** Writes the v2 shape directly, bypassing the migration path. */
async function seedConversations(page: Page, conversations: SeedConversation[]): Promise<void> {
  await page.evaluate(
    async ({ name, records }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name, 2);
        request.onupgradeneeded = () => {
          const result = request.result;
          if (!result.objectStoreNames.contains('history')) result.createObjectStore('history');
          if (!result.objectStoreNames.contains('conversations')) {
            result.createObjectStore('conversations', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('conversations', 'readwrite');
        for (const record of records) tx.objectStore('conversations').put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { name: DB_NAME, records: conversations }
  );
}

async function readConversations(page: Page): Promise<SeedConversation[]> {
  return page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const all = await new Promise<SeedConversation[]>((resolve, reject) => {
      const tx = db.transaction('conversations', 'readonly');
      const request = tx.objectStore('conversations').getAll();
      request.onsuccess = () => resolve(request.result as SeedConversation[]);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return all;
  }, DB_NAME);
}

async function openChat(page: Page, search = ''): Promise<void> {
  await page.goto(`${APP}${search}`, { waitUntil: 'networkidle' });
  await expect(page.getByTestId('chat-history-open')).toBeVisible();
}

const NOW = Date.UTC(2026, 7, 6, 12, 0, 0);
const OLDER: SeedConversation = {
  id: 'conv-older',
  title: 'Älteste Unterhaltung',
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 86_400_000,
  messages: [message('o1', 'user', 'Wie teuer ist Milch?'), message('o2', 'assistant', 'CHF 1.60 bei Aldi.')],
};
const NEWER: SeedConversation = {
  id: 'conv-newer',
  title: 'Neueste Unterhaltung',
  createdAt: NOW,
  updatedAt: NOW,
  messages: [message('n1', 'user', 'Wo gibt es Rüebli?'), message('n2', 'assistant', 'Bei Coop und Migros.')],
};

test.describe('PWA chat history — multi-conversation', () => {
  test('migrates the single v1 record into a titled conversation', async ({ page }) => {
    await gotoSeedPage(page);
    await seedLegacyHistory(page);
    await openChat(page);

    // The upgrade wraps the old record, auto-titled from the first user message.
    await expect
      .poll(async () => (await readConversations(page)).map((c) => c.title))
      .toEqual(['Wo ist Bio-Reis am günstigsten?']);

    const [migrated] = await readConversations(page);
    expect(migrated.messages).toHaveLength(2);

    // The v1 record is deliberately left in place: it is the only copy of
    // pre-migration history if the wrap ever turns out to be wrong.
    const legacy = await page.evaluate(async (name) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const result = await new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction('history', 'readonly');
        const request = tx.objectStore('history').get('messages');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return Array.isArray(result) ? result.length : 0;
    }, DB_NAME);
    expect(legacy).toBe(2);

    // And it is on screen, not merely in the database.
    await expect(page.getByText('Bei Denner für CHF 2.95.')).toBeVisible();
  });

  test('lists conversations newest first and switches between them', async ({ page }) => {
    await gotoSeedPage(page);
    await seedConversations(page, [OLDER, NEWER]);
    await openChat(page);

    // No `?c=`, so the most recently updated conversation is resumed.
    await expect(page.getByText('Bei Coop und Migros.')).toBeVisible();

    await page.getByTestId('chat-history-open').click();
    const items = page.getByTestId('chat-history-item');
    await expect(items).toHaveCount(2);
    await expect(items.first()).toContainText('Neueste Unterhaltung');
    await expect(items.last()).toContainText('Älteste Unterhaltung');

    await items.last().locator('button').first().click();
    await expect(page.getByText('CHF 1.60 bei Aldi.')).toBeVisible();
    await expect(page.getByText('Bei Coop und Migros.')).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('c')).toBe(OLDER.id);
  });

  test('resumes the conversation named by ?c=', async ({ page }) => {
    await gotoSeedPage(page);
    await seedConversations(page, [OLDER, NEWER]);
    await openChat(page, `&c=${OLDER.id}`);

    await expect(page.getByText('CHF 1.60 bei Aldi.')).toBeVisible();
  });

  test('opening a conversation does not reorder the history list', async ({ page }) => {
    await gotoSeedPage(page);
    await seedConversations(page, [OLDER, NEWER]);
    await openChat(page, `&c=${OLDER.id}`);
    await expect(page.getByText('CHF 1.60 bei Aldi.')).toBeVisible();

    // Reading a thread must not count as touching it — otherwise the list
    // reshuffles itself on every visit and "most recent" stops meaning anything.
    await page.waitForTimeout(1_500);
    const stored = await readConversations(page);
    expect(stored.find((c) => c.id === OLDER.id)?.updatedAt).toBe(OLDER.updatedAt);
    expect(stored.find((c) => c.id === NEWER.id)?.updatedAt).toBe(NEWER.updatedAt);
  });

  test('"Neu" opens an empty thread without persisting a blank record', async ({ page }) => {
    await gotoSeedPage(page);
    await seedConversations(page, [NEWER]);
    await openChat(page);

    await page.getByTestId('chat-new-conversation').click();
    await expect(page.getByText('Frag mich nach Produkten, Preisen oder Filialen', { exact: false })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('c')).not.toBe(NEWER.id);

    // A thread nobody has spoken to must not show up in the sheet as a blank row.
    await page.waitForTimeout(1_500);
    expect(await readConversations(page)).toHaveLength(1);
  });

  test('deletes one conversation from the sheet and falls back to the newest remaining', async ({ page }) => {
    await gotoSeedPage(page);
    await seedConversations(page, [OLDER, NEWER]);
    await openChat(page);

    await page.getByTestId('chat-history-open').click();
    await page.getByTestId('chat-history-item').first().locator('button').last().click();

    await expect.poll(async () => (await readConversations(page)).map((c) => c.id)).toEqual([OLDER.id]);
    await expect(page.getByText('CHF 1.60 bei Aldi.')).toBeVisible();
  });

  test('deleting the last conversation lands on the empty state', async ({ page }) => {
    await gotoSeedPage(page);
    await seedConversations(page, [NEWER]);
    await openChat(page);

    await page.getByTestId('chat-delete-current').click();

    await expect.poll(async () => (await readConversations(page)).length).toBe(0);
    await expect(page.getByText('Frag mich nach Produkten, Preisen oder Filialen', { exact: false })).toBeVisible();
    await expect(page.getByTestId('chat-delete-current')).toHaveCount(0);
  });
});
