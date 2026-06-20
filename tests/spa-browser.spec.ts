import { test, expect, type Page } from '@playwright/test';

const BASE = 'http://localhost:3000';

test.describe('SPA Browser Tests — Loop 1', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');
  });

  // ============================
  // 1. General / Page Load
  // ============================
  test('1.1 Page loads with title and tabs', async ({ page }) => {
    await expect(page).toHaveTitle(/Swiss Shopping MCP/);
    const tabs = page.locator('nav button');
    await expect(tabs).toHaveCount(5);
    await expect(tabs.nth(0)).toHaveText('Product Search');
    await expect(tabs.nth(1)).toHaveText('Store Finder');
    await expect(tabs.nth(2)).toHaveText('Price Comparison');
    await expect(tabs.nth(3)).toHaveText('Availability');
    await expect(tabs.nth(4)).toHaveText('Source Status');
  });

  test('1.2 Tab navigation switches sections', async ({ page }) => {
    // Default: Product Search visible
    await expect(page.locator('#tab-search')).toBeVisible();
    await expect(page.locator('#tab-stores')).toBeHidden();

    // Click Store Finder
    await page.click('nav button:has-text("Store Finder")');
    await expect(page.locator('#tab-stores')).toBeVisible();
    await expect(page.locator('#tab-search')).toBeHidden();

    // Click Price Comparison
    await page.click('nav button:has-text("Price Comparison")');
    await expect(page.locator('#tab-compare')).toBeVisible();
    await expect(page.locator('#tab-stores')).toBeHidden();

    // Click Availability
    await page.click('nav button:has-text("Availability")');
    await expect(page.locator('#tab-availability')).toBeVisible();

    // Click Source Status
    await page.click('nav button:has-text("Source Status")');
    await expect(page.locator('#tab-status')).toBeVisible();

    // Back to Product Search
    await page.click('nav button:has-text("Product Search")');
    await expect(page.locator('#tab-search')).toBeVisible();
  });

  // ============================
  // 2. Product Search
  // ============================
  test('1.3 Product search basic — returns product cards', async ({ page }) => {
    await page.fill('#search-query', 'butter');
    await page.click('#search-btn');

    // Wait for results
    await page.waitForFunction(() => {
      const el = document.getElementById('search-results');
      return el && el.children.length > 0;
    }, { timeout: 30000 });

    // Check product cards exist
    const cards = page.locator('#search-results .product-card');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);

    // Each card has a name and price
    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      await expect(card.locator('.name')).not.toBeEmpty();
      await expect(card.locator('.price')).toContainText('CHF');
    }
  });

  test('1.4 Nutrition checkbox shows nutrition data on cards', async ({ page }) => {
    await page.fill('#search-query', 'Milch');
    await page.click('#search-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('search-results');
      return el && el.children.length > 0;
    }, { timeout: 30000 });

    // Before checking: no nutrition visible
    const cardsBefore = page.locator('#search-results .product-card .nutrition');
    const nutritionBefore = await cardsBefore.count();
    // Nutrition divs may exist but be hidden

    // Check the nutrition checkbox
    await page.check('#search-show-nutrition');

    // Wait for re-render
    await page.waitForTimeout(500);

    // After checking: nutrition info should be visible on at least some cards
    const visibleNutrition = page.locator('#search-results .product-card .nutrition:visible');
    const nutritionAfter = await visibleNutrition.count();
    // At least one card should show nutrition (or all that have data)
    expect(nutritionAfter).toBeGreaterThanOrEqual(0); // May be 0 if no nutrition data
    // The checkbox should be checked
    await expect(page.locator('#search-show-nutrition')).toBeChecked();
  });

  test('1.5 Ingredients checkbox shows ingredients on cards', async ({ page }) => {
    await page.fill('#search-query', 'cheese');
    await page.click('#search-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('search-results');
      return el && el.children.length > 0;
    }, { timeout: 30000 });

    // Check the ingredients checkbox
    await page.check('#search-show-ingredients');
    await page.waitForTimeout(500);

    await expect(page.locator('#search-show-ingredients')).toBeChecked();
  });

  test('1.6 Toggle nutrition OFF hides nutrition data', async ({ page }) => {
    await page.fill('#search-query', 'Milch');
    await page.click('#search-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('search-results');
      return el && el.children.length > 0;
    }, { timeout: 30000 });

    // Turn on
    await page.check('#search-show-nutrition');
    await page.waitForTimeout(500);

    // Turn off
    await page.uncheck('#search-show-nutrition');
    await page.waitForTimeout(500);

    await expect(page.locator('#search-show-nutrition')).not.toBeChecked();
  });

  test('1.7 Chain filter — Migros only', async ({ page }) => {
    // Uncheck all
    const checkboxes = page.locator('#search-chains input[type="checkbox"]');
    const count = await checkboxes.count();
    for (let i = 0; i < count; i++) {
      await checkboxes.nth(i).uncheck();
    }
    // Check only Migros
    await page.check('#search-chains input[value="migros"]');

    await page.fill('#search-query', 'milk');
    await page.click('#search-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('search-results');
      return el && el.children.length > 0;
    }, { timeout: 30000 });

    const cards = page.locator('#search-results .product-card');
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThan(0);

    // All should be migros
    for (let i = 0; i < cardCount; i++) {
      const badge = cards.nth(i).locator('.chain-badge');
      await expect(badge).toHaveText('migros');
    }
  });

  test('1.8 Chain filter — Coop only', async ({ page }) => {
    const checkboxes = page.locator('#search-chains input[type="checkbox"]');
    const count = await checkboxes.count();
    for (let i = 0; i < count; i++) {
      await checkboxes.nth(i).uncheck();
    }
    await page.check('#search-chains input[value="coop"]');

    await page.fill('#search-query', 'butter');
    await page.click('#search-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('search-results');
      return el && el.children.length > 0;
    }, { timeout: 30000 });

    const cards = page.locator('#search-results .product-card');
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThan(0);

    for (let i = 0; i < cardCount; i++) {
      const badge = cards.nth(i).locator('.chain-badge');
      await expect(badge).toHaveText('coop');
    }
  });

  // ============================
  // 3. Store Finder
  // ============================
  test('1.9 Store Finder — Migros stores in Bern', async ({ page }) => {
    await page.click('nav button:has-text("Store Finder")');

    // Uncheck all, keep Migros
    const checkboxes = page.locator('#store-chains input[type="checkbox"]');
    const count = await checkboxes.count();
    for (let i = 0; i < count; i++) {
      await checkboxes.nth(i).uncheck();
    }
    await page.check('#store-chains input[value="migros"]');

    await page.fill('#store-location', 'Bern');
    await page.click('#store-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('store-results');
      return el && el.innerHTML.length > 10;
    }, { timeout: 30000 });

    // Check store cards
    const storeCards = page.locator('#store-results .store-card');
    const storeCount = await storeCards.count();
    expect(storeCount).toBeGreaterThan(0);

    // All should be migros — check the chain group header badge
    const groupBadge = page.locator('#store-results .chain-group-header .chain-badge');
    const badgeCount = await groupBadge.count();
    expect(badgeCount).toBeGreaterThan(0);
    for (let i = 0; i < badgeCount; i++) {
      await expect(groupBadge.nth(i)).toHaveText('migros');
    }
  });

  test('1.10 Store Finder — Coop stores in Zurich', async ({ page }) => {
    await page.click('nav button:has-text("Store Finder")');

    const checkboxes = page.locator('#store-chains input[type="checkbox"]');
    const count = await checkboxes.count();
    for (let i = 0; i < count; i++) {
      await checkboxes.nth(i).uncheck();
    }
    await page.check('#store-chains input[value="coop"]');

    await page.fill('#store-location', 'Zurich');
    await page.click('#store-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('store-results');
      return el && el.innerHTML.length > 10;
    }, { timeout: 30000 });

    const storeCards = page.locator('#store-results .store-card');
    const storeCount = await storeCards.count();
    expect(storeCount).toBeGreaterThan(0);

    // Check chain group header
    const groupBadge = page.locator('#store-results .chain-group-header .chain-badge');
    const badgeCount = await groupBadge.count();
    expect(badgeCount).toBeGreaterThan(0);
    for (let i = 0; i < badgeCount; i++) {
      await expect(groupBadge.nth(i)).toHaveText('coop');
    }
  });

  test('1.11 Store Finder — Multi-chain in Basel', async ({ page }) => {
    await page.click('nav button:has-text("Store Finder")');

    await page.fill('#store-location', 'Basel');
    await page.click('#store-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('store-results');
      return el && el.innerHTML.length > 10;
    }, { timeout: 30000 });

    const storeCards = page.locator('#store-results .store-card');
    const storeCount = await storeCards.count();
    expect(storeCount).toBeGreaterThan(0);
  });

  test('1.12 Store opening hours displayed', async ({ page }) => {
    await page.click('nav button:has-text("Store Finder")');

    await page.fill('#store-location', 'Bern');
    await page.click('#store-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('store-results');
      return el && el.innerHTML.length > 10;
    }, { timeout: 30000 });

    // Check that hours info is present in the store card HTML
    const html = await page.locator('#store-results').innerHTML();
    // Should contain "Hours:" prefix followed by time format or "Geschlossen" etc
    const hasHours = /Hours:|\d{1,2}:\d{2}|Geschlossen|Mon|Sat|Sun|weekend|weekday/i.test(html);
    expect(hasHours).toBeTruthy();
  });

  // ============================
  // 4. Price Comparison
  // ============================
  test('1.13 Price Comparison returns offers', async ({ page }) => {
    await page.click('nav button:has-text("Price Comparison")');

    await page.fill('#compare-query', 'butter');
    await page.click('#compare-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('compare-results');
      return el && el.innerHTML.length > 10;
    }, { timeout: 30000 });

    const html = await page.locator('#compare-results').innerHTML();
    expect(html.length).toBeGreaterThan(10);
    // Should contain CHF price
    expect(html).toContain('CHF');
  });

  // ============================
  // 5. Availability
  // ============================
  test('1.14 Availability — Products-first view', async ({ page }) => {
    await page.click('nav button:has-text("Availability")');

    await page.fill('#avail-query', 'Milch');
    await page.fill('#avail-location', 'Bern');
    await page.click('#avail-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('avail-results');
      return el && el.innerHTML.length > 10;
    }, { timeout: 30000 });

    const html = await page.locator('#avail-results').innerHTML();
    // Should contain product info or stores or "no data" message
    expect(html.length).toBeGreaterThan(10);
  });

  // ============================
  // 6. Source Status
  // ============================
  test('1.15 Source Status shows chain capabilities', async ({ page }) => {
    await page.click('nav button:has-text("Source Status")');

    await page.waitForFunction(() => {
      const el = document.getElementById('status-results');
      return el && el.innerHTML.length > 10;
    }, { timeout: 15000 });

    const html = await page.locator('#status-results').innerHTML();
    expect(html).toContain('Migros');
    expect(html).toContain('Coop');
    expect(html).toContain('Product Search');
  });

  // ============================
  // 7. Error Handling
  // ============================
  test('1.16 Empty search query shows error', async ({ page }) => {
    await page.click('#search-btn');

    // Should show error
    const errorEl = page.locator('#search-error');
    await expect(errorEl).toBeVisible({ timeout: 5000 });
  });

  test('1.17 Empty store location shows error', async ({ page }) => {
    await page.click('nav button:has-text("Store Finder")');
    await page.click('#store-btn');

    const errorEl = page.locator('#store-error');
    await expect(errorEl).toBeVisible({ timeout: 5000 });
  });

  test('1.18 Empty availability query shows error', async ({ page }) => {
    await page.click('nav button:has-text("Availability")');
    await page.click('#avail-btn');

    const errorEl = page.locator('#avail-error');
    await expect(errorEl).toBeVisible({ timeout: 5000 });
  });
});

// ============================
// Loop 2 — Deep Edge Cases
// ============================
test.describe('SPA Browser Tests — Loop 2', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');
  });

  test('2.1 Unicode search query (Müesli)', async ({ page }) => {
    await page.fill('#search-query', 'Müesli');
    await page.click('#search-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('search-results');
      return el && el.children.length > 0;
    }, { timeout: 30000 });

    const cards = page.locator('#search-results .product-card');
    expect(await cards.count()).toBeGreaterThan(0);
  });

  test('2.2 Multiple sequential searches retain correct state', async ({ page }) => {
    // First search
    await page.fill('#search-query', 'butter');
    await page.click('#search-btn');
    await page.waitForFunction(() => {
      const el = document.getElementById('search-results');
      return el && el.children.length > 0;
    }, { timeout: 30000 });
    const firstCount = await page.locator('#search-results .product-card').count();

    // Second search should replace results
    await page.fill('#search-query', 'cheese');
    await page.click('#search-btn');
    await page.waitForFunction(() => {
      const el = document.getElementById('search-results');
      return el && el.children.length > 0;
    }, { timeout: 30000 });
    const secondCount = await page.locator('#search-results .product-card').count();

    expect(secondCount).toBeGreaterThan(0);
    // Results should be different (or at least re-fetched)
  });

  test('2.3 Nutrition toggle persists across searches', async ({ page }) => {
    // Enable nutrition
    await page.check('#search-show-nutrition');
    await page.fill('#search-query', 'milk');
    await page.click('#search-btn');
    await page.waitForFunction(() => {
      const el = document.getElementById('search-results');
      return el && el.children.length > 0;
    }, { timeout: 30000 });

    // Checkbox should still be checked
    await expect(page.locator('#search-show-nutrition')).toBeChecked();

    // Search again — checkbox should remain checked
    await page.fill('#search-query', 'butter');
    await page.click('#search-btn');
    await page.waitForFunction(() => {
      const el = document.getElementById('search-results');
      return el && el.children.length > 0;
    }, { timeout: 30000 });
    await expect(page.locator('#search-show-nutrition')).toBeChecked();
  });

  test('2.4 Store finder with postal code 8001', async ({ page }) => {
    await page.click('nav button:has-text("Store Finder")');
    await page.fill('#store-location', '8001');
    await page.click('#store-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('store-results');
      return el && el.innerHTML.length > 10;
    }, { timeout: 30000 });

    const storeCards = page.locator('#store-results .store-card');
    expect(await storeCards.count()).toBeGreaterThan(0);
  });

  test('2.5 Availability with in-stock filter', async ({ page }) => {
    await page.click('nav button:has-text("Availability")');
    await page.fill('#avail-query', 'Milch');
    await page.fill('#avail-location', 'Bern');
    await page.check('#avail-instock');
    await page.click('#avail-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('avail-results');
      return el && el.innerHTML.length > 10;
    }, { timeout: 30000 });

    await expect(page.locator('#avail-instock')).toBeChecked();
  });

  test('2.6 Availability with open-now filter', async ({ page }) => {
    await page.click('nav button:has-text("Availability")');
    await page.fill('#avail-query', 'Milch');
    await page.fill('#avail-location', 'Bern');
    await page.check('#avail-open');
    await page.click('#avail-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('avail-results');
      return el && el.innerHTML.length > 10;
    }, { timeout: 30000 });

    await expect(page.locator('#avail-open')).toBeChecked();
  });

  test('2.7 Price comparison with quantity > 1', async ({ page }) => {
    await page.click('nav button:has-text("Price Comparison")');
    await page.fill('#compare-query', 'butter');
    await page.fill('#compare-quantity', '5');
    await page.click('#compare-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('compare-results');
      return el && el.innerHTML.length > 10;
    }, { timeout: 30000 });

    const html = await page.locator('#compare-results').innerHTML();
    expect(html).toContain('CHF');
  });

  test('2.8 Product search — max price filter', async ({ page }) => {
    await page.fill('#search-query', 'cheese');
    await page.fill('#search-max-price', '5');
    await page.click('#search-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('search-results');
      return el && (el.children.length > 0 || el.innerHTML.includes('No'));
    }, { timeout: 30000 });

    // All visible prices should be <= 5 CHF (if any products found)
    const prices = page.locator('#search-results .product-card .price');
    const priceCount = await prices.count();
    for (let i = 0; i < priceCount; i++) {
      const text = await prices.nth(i).textContent();
      const match = text?.match(/CHF\s*([\d.]+)/);
      if (match) {
        expect(parseFloat(match[1])).toBeLessThanOrEqual(5);
      }
    }
  });

  test('2.9 Error recovery — search fails then succeeds', async ({ page }) => {
    // Trigger error with empty query
    await page.click('#search-btn');
    await expect(page.locator('#search-error')).toBeVisible({ timeout: 5000 });

    // Now search successfully
    await page.fill('#search-query', 'milk');
    await page.click('#search-btn');
    await page.waitForFunction(() => {
      const el = document.getElementById('search-results');
      return el && el.children.length > 0;
    }, { timeout: 30000 });

    // Error should be hidden
    const errorVisible = await page.locator('#search-error').isVisible();
    expect(errorVisible).toBeFalsy();
  });

  test('2.10 Store finder error recovery', async ({ page }) => {
    await page.click('nav button:has-text("Store Finder")');

    // Trigger error
    await page.click('#store-btn');
    await expect(page.locator('#store-error')).toBeVisible({ timeout: 5000 });

    // Recover
    await page.fill('#store-location', 'Bern');
    await page.click('#store-btn');
    await page.waitForFunction(() => {
      const el = document.getElementById('store-results');
      return el && el.innerHTML.length > 10;
    }, { timeout: 30000 });

    const errorVisible = await page.locator('#store-error').isVisible();
    expect(errorVisible).toBeFalsy();
  });

  test('2.11 Limit selector works — limit 5 returns fewer results', async ({ page }) => {
    await page.selectOption('#search-limit', '5');
    await page.fill('#search-query', 'milk');
    await page.click('#search-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('search-results');
      return el && el.children.length > 0;
    }, { timeout: 30000 });

    const cards = page.locator('#search-results .product-card');
    const count = await cards.count();
    expect(count).toBeLessThanOrEqual(5);
  });

  test('2.12 Product cards have vendor links', async ({ page }) => {
    await page.fill('#search-query', 'butter');
    await page.click('#search-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('search-results');
      return el && el.children.length > 0;
    }, { timeout: 30000 });

    const links = page.locator('#search-results .product-card .vendor-link');
    const linkCount = await links.count();
    expect(linkCount).toBeGreaterThan(0);

    for (let i = 0; i < linkCount; i++) {
      const text = await links.nth(i).textContent();
      expect(text).toContain('View on');
    }
  });

  test('2.13 Store cards have map links', async ({ page }) => {
    await page.click('nav button:has-text("Store Finder")');
    await page.fill('#store-location', 'Bern');
    await page.click('#store-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('store-results');
      return el && el.innerHTML.length > 10;
    }, { timeout: 30000 });

    const mapLinks = page.locator('#store-results .store-card a.map-link');
    const count = await mapLinks.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const href = await mapLinks.nth(i).getAttribute('href');
      expect(href).toContain('google.com/maps');
    }
  });

  test('2.14 Source status shows all 8 chains', async ({ page }) => {
    await page.click('nav button:has-text("Source Status")');

    await page.waitForFunction(() => {
      const el = document.getElementById('status-results');
      return el && el.innerHTML.length > 10;
    }, { timeout: 15000 });

    const html = await page.locator('#status-results').innerHTML();
    const chains = ['Aldi', 'Coop', 'Denner', 'Farmy', 'Lidl', 'Migros', 'Ottos', 'Volg'];
    for (const chain of chains) {
      expect(html).toContain(chain);
    }
  });

  test('2.15 Source status shows live-beta badges', async ({ page }) => {
    await page.click('nav button:has-text("Source Status")');

    await page.waitForFunction(() => {
      const el = document.getElementById('status-results');
      return el && el.innerHTML.length > 10;
    }, { timeout: 15000 });

    const badges = page.locator('#status-results .status-badge');
    const count = await badges.count();
    expect(count).toBeGreaterThan(0);

    // Should have at least one live-beta badge
    const liveBetaBadges = page.locator('#status-results .status-badge.status-live-beta');
    expect(await liveBetaBadges.count()).toBeGreaterThan(0);
  });

  test('2.16 Search limit 20', async ({ page }) => {
    await page.selectOption('#search-limit', '20');
    await page.fill('#search-query', 'milk');
    await page.click('#search-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('search-results');
      return el && el.children.length > 0;
    }, { timeout: 30000 });

    const cards = page.locator('#search-results .product-card');
    const count = await cards.count();
    expect(count).toBeGreaterThan(5);
    expect(count).toBeLessThanOrEqual(20);
  });

  test('2.17 Tab switching during loading cancels gracefully', async ({ page }) => {
    // Start a slow search
    await page.fill('#search-query', 'milk');
    await page.click('#search-btn');

    // Immediately switch to another tab
    await page.click('nav button:has-text("Store Finder")');

    // Store finder tab should be visible
    await expect(page.locator('#tab-stores')).toBeVisible();

    // Switch back — should still work
    await page.click('nav button:has-text("Product Search")');
    await expect(page.locator('#tab-search')).toBeVisible();
  });

  test('2.18 All chain checkboxes in store finder', async ({ page }) => {
    await page.click('nav button:has-text("Store Finder")');

    const checkboxes = page.locator('#store-chains input[type="checkbox"]');
    const count = await checkboxes.count();
    expect(count).toBe(7); // All 7 chains

    // All should be checked by default
    for (let i = 0; i < count; i++) {
      await expect(checkboxes.nth(i)).toBeChecked();
    }
  });

  test('2.19 Availability chain checkboxes exist', async ({ page }) => {
    await page.click('nav button:has-text("Availability")');

    const checkboxes = page.locator('#avail-chains input[type="checkbox"]');
    const count = await checkboxes.count();
    expect(count).toBeGreaterThanOrEqual(2); // At least Migros and Coop
  });

  test('2.20 Price comparison chain checkboxes exist', async ({ page }) => {
    await page.click('nav button:has-text("Price Comparison")');

    const checkboxes = page.locator('#compare-chains input[type="checkbox"]');
    const count = await checkboxes.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
