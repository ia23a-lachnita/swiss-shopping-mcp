import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';

test.describe('SPA Bug Fixes — Round 2', () => {

  test('1. Nutrition button toggles visibility (not blank)', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.fill('#search-query', 'Vollmilch');
    await page.click('#search-btn');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 15000 });

    // Nutrition expandable should start hidden
    const expandable = page.locator('#search-results .expandable').first();
    await expect(expandable).not.toHaveClass(/open/);

    // Click the nutrition button — should open
    const btn = page.locator('#search-results .expand-btn:has-text("Nutrition")').first();
    await btn.click();
    await expect(expandable).toHaveClass(/open/);

    // Click again — should close
    await btn.click();
    await expect(expandable).not.toHaveClass(/open/);

    // Click again — should open again (not go blank)
    await btn.click();
    await expect(expandable).toHaveClass(/open/);
    // Verify content is still there
    await expect(expandable.locator('dl.nutrition-grid')).toBeVisible();
  });

  test('2. Ingredients button toggles allergens display', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.fill('#search-query', 'Vollmilch');
    await page.click('#search-btn');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 15000 });

    // Find the ingredients expandable (second expandable in a card with nutrition)
    const btn = page.locator('#search-results .expand-btn:has-text("Ingredients")').first();
    const expandable = page.locator('#search-results .expandable').nth(1);

    // Should start hidden
    await expect(expandable).not.toHaveClass(/open/);

    // Click — should open
    await btn.click();
    await expect(expandable).toHaveClass(/open/);
    // Content should show allergens text
    await expect(expandable.locator('.ingredients-text')).toBeVisible();
    const text = await expandable.locator('.ingredients-text').textContent();
    expect(text!.length).toBeGreaterThan(0);

    // Click again — should close
    await btn.click();
    await expect(expandable).not.toHaveClass(/open/);
  });

  test('3. Nutrition checkbox re-renders with nutrition expanded', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    // Check nutrition before searching
    await page.check('#search-show-nutrition');

    await page.fill('#search-query', 'Vollmilch');
    await page.click('#search-btn');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 15000 });

    // Nutrition expandables should be open (checkbox was checked)
    const openExpandables = page.locator('#search-results .expandable.open');
    const count = await openExpandables.count();
    expect(count).toBeGreaterThan(0);
  });

  test('4. Availability shows per-chain stores (Migros product -> Migros stores)', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.click('nav button:has-text("Availability")');
    await expect(page.locator('#tab-availability')).toBeVisible();

    await page.fill('#avail-query', 'Milch');
    await page.fill('#avail-location', 'Bern');
    await page.click('#avail-btn');

    await expect(page.locator('#avail-results .product-card').first()).toBeVisible({ timeout: 30000 });

    // Check each card: store chain should match product chain
    const cards = page.locator('#avail-results .product-card');
    const cardCount = await cards.count();
    for (let i = 0; i < cardCount; i++) {
      const card = cards.nth(i);
      const badge = await card.locator('.chain-badge').textContent();
      const storeText = await card.locator('div:has-text("stores:")').first().textContent();
      if (storeText && storeText.includes('migros')) {
        // If it says "Migros stores:", there should be no "Coop stores:" text
        expect(storeText).not.toMatch(/coop stores/i);
      }
      if (storeText && storeText.includes('coop')) {
        expect(storeText).not.toMatch(/migros stores/i);
      }
    }
  });

  test('5. Availability shows 2-column grid layout', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.click('nav button:has-text("Availability")');
    await expect(page.locator('#tab-availability')).toBeVisible();

    await page.fill('#avail-query', 'Milch');
    await page.fill('#avail-location', 'Bern');
    await page.click('#avail-btn');

    await expect(page.locator('#avail-results .product-card').first()).toBeVisible({ timeout: 30000 });

    // Grid should have 2-column layout
    const grid = page.locator('#avail-results .product-grid');
    const style = await grid.getAttribute('style');
    expect(style).toContain('repeat(2, 1fr)');

    // Should have multiple products
    const cardCount = await page.locator('#avail-results .product-card').count();
    expect(cardCount).toBeGreaterThan(1);
  });

  test('6. Availability card shows nutrition preview for Migros products', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.click('nav button:has-text("Availability")');
    await expect(page.locator('#tab-availability')).toBeVisible();

    await page.fill('#avail-query', 'Milch');
    await page.fill('#avail-location', 'Bern');
    await page.click('#avail-btn');

    await expect(page.locator('#avail-results .product-card').first()).toBeVisible({ timeout: 30000 });

    // Should show kcal info on Migros product cards
    const html = await page.locator('#avail-results').innerHTML();
    expect(html).toMatch(/\d+\s*kcal/);
  });

  test('7. Store finder shows opening hours', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.click('nav button:has-text("Store Finder")');
    await expect(page.locator('#tab-stores')).toBeVisible();

    await page.fill('#store-location', 'Bern');
    await page.click('#store-btn');

    await expect(page.locator('#store-results .store-card').first()).toBeVisible({ timeout: 15000 });

    const html = await page.locator('#store-results').innerHTML();
    expect(html).toMatch(/Hours|Geschlossen|\d{1,2}:\d{2}/);
  });
});
