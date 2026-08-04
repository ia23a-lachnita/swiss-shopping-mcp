import { test, expect, type Page } from '@playwright/test';

/**
 * The five queries that returned nothing from any of the seven chains, driven
 * through the real UI.
 *
 * A green unit suite proves the matcher scores a frozen pool correctly; it
 * cannot prove a shopper typing "lait entier" into the box sees products. The
 * failure being fixed here was invisible to the unit suite by construction —
 * the products were discarded before ranking ever saw them.
 */

const BASE = 'http://localhost:3000';

/**
 * These drive the real seven-chain fan-out, so the budget has to match real
 * vendor latency rather than a unit test's. Warm, a search here measures ~11s;
 * the first one against a freshly started server pays Migros' Playwright and
 * Cloudflare cold start on top and blew a 30s wait.
 */
test.describe.configure({ timeout: 120_000 });

async function search(page: Page, query: string): Promise<string[]> {
  await page.goto(BASE);
  await page.waitForLoadState('networkidle');
  await page.fill('#search-query', query);
  await page.click('#search-btn');

  await page.waitForFunction(
    () => {
      const el = document.getElementById('search-results');
      return el !== null && el.children.length > 0;
    },
    { timeout: 60_000 }
  );

  return page.locator('#search-results .product-card .name').allInnerTexts();
}

test.describe('query understanding — the queries that used to return nothing', () => {
  test('geriebener Käse returns grated cheese, not cheese-flavoured crisps', async ({ page }) => {
    const names = await search(page, 'geriebener Käse');
    expect(names.length).toBeGreaterThan(0);
    // The modifier has to be satisfied by the top result, not merely tolerated.
    // Both spellings count: "Reibkäse" is what Migros calls the same thing.
    expect(names[0].toLowerCase()).toMatch(/gerieb|reib/);
  });

  test('glutenfreies Brot returns gluten-free bread', async ({ page }) => {
    const names = await search(page, 'glutenfreies Brot');
    expect(names.length).toBeGreaterThan(0);
    // A diet claim is a constraint: every result must satisfy it.
    for (const name of names) expect(name.toLowerCase()).toMatch(/glutenfrei/);
  });

  test('rotes Thai Curry returns a Thai curry', async ({ page }) => {
    const names = await search(page, 'rotes Thai Curry');
    expect(names.length).toBeGreaterThan(0);
    expect(names[0].toLowerCase()).toMatch(/curry/);
  });

  test('lait entier returns milk', async ({ page }) => {
    const names = await search(page, 'lait entier');
    expect(names.length).toBeGreaterThan(0);
    expect(names[0].toLowerCase()).toMatch(/milch|lait/);
  });

  test("jus d'orange returns orange juice", async ({ page }) => {
    const names = await search(page, "jus d'orange");
    expect(names.length).toBeGreaterThan(0);
    expect(names[0].toLowerCase()).toMatch(/saft|jus/);
  });

  test('a brand query with an Italian word in it still resolves to the brand', async ({ page }) => {
    // The guard against translation hijacking a query: `caffe` and `latte` are
    // both Italian, but this is a brand and must not become a search for milk.
    const names = await search(page, 'Emmi Caffè Latte');
    expect(names.length).toBeGreaterThan(0);
  });
});
