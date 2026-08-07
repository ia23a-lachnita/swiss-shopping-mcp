import { test, expect, type Page } from '@playwright/test';

/**
 * Compare-screen controls (reported from a real phone, 2026-08-07).
 *
 * Three defects, all of which passed every existing test because they are
 * about what the form does *after* results are on screen:
 *  - the submit button stayed fully lit when pressing it could not do anything,
 *    so the only feedback was a press that changed nothing;
 *  - adding a vendor that was not part of the last search showed nothing for it
 *    and gave no affordance to re-run;
 *  - moving the pack-count stepper with offers on screen changed nothing at all.
 *
 * The vendor fan-out is mocked so this is deterministic and costs no live call —
 * every assertion here is about client-side form state, not about search.
 */

const APP = 'http://localhost:3000/app?tab=compare';

interface MockOffer {
  chain: string;
  id: string;
  name: string;
  price: number;
  baseUnitPrice?: number;
  baseUnit?: string;
}

const OFFERS: MockOffer[] = [
  { chain: 'migros', id: 'm1', name: 'Banane', price: 2.95, baseUnitPrice: 3.0, baseUnit: 'kg' },
  { chain: 'coop', id: 'c1', name: 'Bio Bananen', price: 3.2, baseUnitPrice: 3.2, baseUnit: 'kg' },
  { chain: 'aldi', id: 'a1', name: 'Bananen Aldi', price: 2.5 },
];

/** Serves the fan-out from a fixture and counts how many times it is asked. */
async function mockCompare(page: Page): Promise<() => number> {
  let calls = 0;
  await page.route('**/api/compare-prices', async (route) => {
    calls += 1;
    const body = route.request().postDataJSON() as { query: string; chains?: string[] };
    const chains = body.chains ?? OFFERS.map((o) => o.chain);
    const offers = OFFERS.filter((o) => chains.includes(o.chain)).map((o) => ({
      chain: o.chain,
      product: { id: o.id, chain: o.chain, name: o.name, price: { current: o.price } },
      effectivePrice: o.price,
      totalPrice: o.price,
      comparisonEligible: true,
      comparisonUnit: 'pack',
      ...(o.baseUnitPrice !== undefined
        ? { baseUnitPrice: o.baseUnitPrice, baseUnit: o.baseUnit }
        : {}),
    }));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: { query: body.query, quantity: 1, offers } }),
    });
  });
  return () => calls;
}

function submitButton(page: Page) {
  return page.locator('form button[type=submit]');
}

function chip(page: Page, label: string) {
  return page.locator(`form button:has-text("${label}")`).first();
}

async function search(page: Page, query: string): Promise<void> {
  await page.locator('input[placeholder*="vergleichen"]').fill(query);
  // The suggestion dropdown overlays the submit button until it is dismissed.
  await page.keyboard.press('Escape');
  await submitButton(page).click();
  await expect(page.locator('ul li').first()).toBeVisible();
}

test.describe('Compare screen — form controls after results exist', () => {
  let compareCalls: () => number;

  test.beforeEach(async ({ page }) => {
    compareCalls = await mockCompare(page);
    // Silence autocomplete. Its dropdown is absolutely positioned over the
    // vendor chips, and it resolves asynchronously, so a live one turns every
    // chip click in this file into a race against a popup this spec is not
    // about. The suggestion UI has its own coverage.
    await page.route('**/api/query-suggest*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { suggestions: [] } }),
      })
    );
    await page.goto(APP);
    await page.waitForSelector('form button[type=submit]');
  });

  test('the button goes visibly inert once its results are on screen', async ({ page }) => {
    await search(page, 'Banane');

    const button = submitButton(page);
    await expect(button).toBeDisabled();
    // Functionally inert was never the complaint — react-query already deduped
    // an identical key. It has to *look* spent too.
    await expect(button).toHaveCSS('opacity', '0.5');
    await expect(button).toHaveCSS('pointer-events', 'none');
  });

  test('removing a vendor re-filters on screen and re-arms the button', async ({ page }) => {
    await search(page, 'Banane');
    await expect(page.locator('ul li')).toHaveCount(3);

    await chip(page, 'Coop').click();

    await expect(page.locator('ul li')).toHaveCount(2);
    await expect(page.locator('ul li', { hasText: 'Bio Bananen' })).toHaveCount(0);
    await expect(submitButton(page)).toBeEnabled();
    await expect(submitButton(page)).toHaveText(/Neu vergleichen/);
  });

  test('adding a vendor that was not searched re-arms the button', async ({ page }) => {
    await chip(page, 'Aldi').click(); // search without Aldi
    await search(page, 'Banane');
    await expect(submitButton(page)).toBeDisabled();

    await chip(page, 'Aldi').click();

    // Nothing was ever fetched for Aldi, so the list cannot show it yet — the
    // button becoming pressable again is the entire remedy.
    await expect(submitButton(page)).toBeEnabled();
    await expect(submitButton(page)).toHaveText(/Neu vergleichen/);

    await submitButton(page).click();
    await expect(page.locator('ul li', { hasText: 'Bananen Aldi' })).toHaveCount(1);
    await expect(submitButton(page)).toBeDisabled();
  });

  test('the pack count re-prices what is on screen without a new request', async ({ page }) => {
    await search(page, 'Banane');
    const afterSearch = compareCalls();

    const cheapest = page.locator('ul li').first();
    await expect(cheapest).toContainText('2.50');

    await page.locator('button[aria-label="Mehr Packungen"]').click();
    await page.locator('button[aria-label="Mehr Packungen"]').click();

    // 2.50 x 3, computed client-side from effectivePrice.
    await expect(cheapest).toContainText('7.50');
    await expect(cheapest).toContainText('2.50'); // the "à" per-pack line
    expect(compareCalls()).toBe(afterSearch);
    // A display multiplier must not invalidate the query it is applied to.
    await expect(submitButton(page)).toBeDisabled();
  });

  test('shows a normalized Grundpreis, and marks only the rows missing one', async ({ page }) => {
    await search(page, 'Banane');

    // Migros and Coop both publish a unit price, normalized to the same base.
    await expect(page.locator('ul li', { hasText: 'Migros' })).toContainText('/ kg');
    await expect(page.locator('ul li', { hasText: 'Bio Bananen' })).toContainText('/ kg');
    // Aldi publishes no unit price; the marker earns its place only because
    // other rows in the same list do have one.
    await expect(page.locator('text=Kein Grundpreis')).toHaveCount(1);

    // With every unit-priced vendor removed, nobody has a Grundpreis and the
    // marker would be noise on every row.
    await chip(page, 'Migros').click();
    await chip(page, 'Coop').click();
    await submitButton(page).click();
    await expect(page.locator('ul li')).toHaveCount(1);
    await expect(page.locator('text=Kein Grundpreis')).toHaveCount(0);
  });

  test('deselecting every vendor disables the button and says why', async ({ page }) => {
    await search(page, 'Banane');
    for (const label of ['Migros', 'Coop', 'Aldi', 'Denner', 'Lidl', 'Volg', "Otto's"]) {
      await chip(page, label).click();
    }

    await expect(submitButton(page)).toBeDisabled();
    await expect(page.locator('text=Mindestens ein Händler')).toBeVisible();
  });
});
