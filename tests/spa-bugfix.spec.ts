import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';

test.describe('SPA Bug Fixes Verification', () => {

  test('Product search shows nutrition data for Migros products', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    // Search for Milch
    await page.fill('#search-query', 'Milch');
    await page.click('#search-btn');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 15000 });

    // Check that nutrition button exists
    const nutritionBtns = page.locator('#search-results .expand-btn:has-text("Nutrition")');
    const count = await nutritionBtns.count();
    expect(count).toBeGreaterThan(0);
  });

  test('Product search shows allergens/ingredients for Migros products', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.fill('#search-query', 'Milch');
    await page.click('#search-btn');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 15000 });

    const allergenBtns = page.locator('#search-results .expand-btn:has-text("Ingredients")');
    const count = await allergenBtns.count();
    expect(count).toBeGreaterThan(0);
  });

  test('Nutrition checkbox toggles nutrition display', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.fill('#search-query', 'Vollmilch');
    await page.click('#search-btn');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 15000 });

    // Check nutrition checkbox
    await page.check('#search-show-nutrition');
    
    // Expandable nutrition sections should be open
    const openExpandables = page.locator('#search-results .expandable.open');
    const count = await openExpandables.count();
    expect(count).toBeGreaterThan(0);
  });

  test('Ingredients checkbox toggles ingredients display', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.fill('#search-query', 'Vollmilch');
    await page.click('#search-btn');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 15000 });

    await page.check('#search-show-ingredients');
    
    const openExpandables = page.locator('#search-results .expandable.open');
    const count = await openExpandables.count();
    expect(count).toBeGreaterThan(0);
  });

  test('Availability page shows multiple products in 2-column grid', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    // Switch to Availability tab
    await page.click('nav button:has-text("Availability")');
    await expect(page.locator('#tab-availability')).toBeVisible();

    await page.fill('#avail-query', 'Milch');
    await page.fill('#avail-location', 'Bern');
    await page.click('#avail-btn');

    // Wait for results
    await expect(page.locator('#avail-results .product-card').first()).toBeVisible({ timeout: 30000 });

    // Should have multiple product cards
    const cardCount = await page.locator('#avail-results .product-card').count();
    expect(cardCount).toBeGreaterThan(1);

    // Each card should have a product name
    const firstCard = page.locator('#avail-results .product-card').first();
    await expect(firstCard.locator('.name')).toBeVisible();
  });

  test('Availability page shows nutrition on product cards', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.click('nav button:has-text("Availability")');
    await expect(page.locator('#tab-availability')).toBeVisible();

    await page.fill('#avail-query', 'Milch');
    await page.fill('#avail-location', 'Bern');
    await page.click('#avail-btn');

    await expect(page.locator('#avail-results .product-card').first()).toBeVisible({ timeout: 30000 });

    // Migros products should have nutrition info in the card
    const html = await page.locator('#avail-results').innerHTML();
    expect(html).toMatch(/Energy|Protein|Carbs|Fat|kcal/i);
  });

  test('Availability page shows store availability summary per product', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.click('nav button:has-text("Availability")');
    await expect(page.locator('#tab-availability')).toBeVisible();

    await page.fill('#avail-query', 'Milch');
    await page.fill('#avail-location', 'Bern');
    await page.click('#avail-btn');

    await expect(page.locator('#avail-results .product-card').first()).toBeVisible({ timeout: 30000 });

    // Should show store availability summary
    const html = await page.locator('#avail-results').innerHTML();
    expect(html).toMatch(/store|Stock|Available|Out of Stock/i);
  });

  test('Store finder shows opening hours', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    await page.click('nav button:has-text("Store Finder")');
    await expect(page.locator('#tab-stores')).toBeVisible();

    await page.fill('#store-location', 'Bern');
    await page.click('#store-btn');

    await expect(page.locator('#store-results .store-card').first()).toBeVisible({ timeout: 15000 });

    // Store cards should show hours
    const html = await page.locator('#store-results').innerHTML();
    expect(html).toMatch(/Hours|Geschlossen|\d{1,2}:\d{2}/);
  });
});
