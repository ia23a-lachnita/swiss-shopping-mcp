#!/usr/bin/env node
/**
 * Loop 1: Comprehensive SPA test cases
 * Tests all recently fixed features:
 * 1. Migros store search (was 401, now fixed)
 * 2. Store opening hours format (weekday/weekend)
 * 3. Nutrition/ingredients toggle
 * 4. Products-first availability view
 * 5. Currently open filter
 * 6. Source status tab
 * 7. Price comparison
 * 8. Product search with all chains
 */

const BASE = 'http://localhost:3000';
let passed = 0;
let failed = 0;
const failures = [];

async function apiPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`);
  return res.json();
}

function assert(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    const msg = `  ✗ ${name}${detail ? ': ' + detail : ''}`;
    console.log(msg);
    failures.push(msg);
  }
}

// ─── Test 1: Migros Store Search ───
async function testMigrosStoreSearch() {
  console.log('\n=== Test: Migros Store Search (was 401) ===');
  const result = await apiPost('/api/find-stores', { location: 'Bern', chains: ['migros'], limit: 5 });

  assert('Returns ok:true', result.ok === true, JSON.stringify(result.error));
  assert('Has store data', Array.isArray(result.data), 'data is not array');
  assert('Has at least 1 store', result.data?.length >= 1, `got ${result.data?.length}`);

  if (result.data?.length > 0) {
    const store = result.data[0];
    assert('Store has chain=migros', store.chain === 'migros', `got ${store.chain}`);
    assert('Store has name', typeof store.name === 'string' && store.name.length > 0, `name: ${store.name}`);
    assert('Store has location with lat/lng',
      store.location?.latitude && store.location?.longitude,
      JSON.stringify(store.location));
    assert('Store name is not numeric', !/^\d+$/.test(store.name), `name: ${store.name}`);

    // Check opening hours format
    if (store.openingHours) {
      assert('Opening hours is string', typeof store.openingHours === 'string');
      const hasWeekday = store.openingHours.includes('Mon-Fri');
      const hasWeekend = store.openingHours.includes('Sat-Sun');
      assert('Opening hours has weekday format', hasWeekday || hasWeekend,
        `hours: ${store.openingHours}`);
    }
  }
}

// ─── Test 2: Coop Store Search ───
async function testCoopStoreSearch() {
  console.log('\n=== Test: Coop Store Search ===');
  const result = await apiPost('/api/find-stores', { location: 'Zurich', chains: ['coop'], limit: 5 });

  assert('Returns ok:true', result.ok === true, JSON.stringify(result.error));
  assert('Has store data', Array.isArray(result.data), 'data is not array');
  assert('Has at least 1 store', result.data?.length >= 1, `got ${result.data?.length}`);

  if (result.data?.length > 0) {
    const store = result.data[0];
    assert('Store has chain=coop', store.chain === 'coop', `got ${store.chain}`);
    assert('Store has address', typeof store.address === 'string' && store.address.length > 0, `address: ${store.address}`);

    // Check Coop opening hours format
    if (store.openingHours) {
      assert('Opening hours is string', typeof store.openingHours === 'string');
    }
  }
}

// ─── Test 3: Multi-chain Store Search ───
async function testMultiChainStoreSearch() {
  console.log('\n=== Test: Multi-chain Store Search ===');
  const result = await apiPost('/api/find-stores', { location: 'Basel', chains: ['migros', 'coop', 'lidl'], limit: 15 });

  assert('Returns ok:true', result.ok === true, JSON.stringify(result.error));
  assert('Has store data', Array.isArray(result.data));

  const chains = new Set(result.data?.map(s => s.chain));
  assert('Has multiple chain types', chains.size >= 2, `chains: ${[...chains].join(', ')}`);
}

// ─── Test 4: Product Search Across Chains ───
async function testProductSearch() {
  console.log('\n=== Test: Product Search ===');
  const result = await apiPost('/api/search-products', { query: 'milk', chains: ['migros', 'coop'], limit: 10 });

  assert('Returns ok:true', result.ok === true, JSON.stringify(result.error));
  assert('Has product data', Array.isArray(result.data));
  assert('Has at least 1 product', result.data?.length >= 1, `got ${result.data?.length}`);

  if (result.data?.length > 0) {
    const p = result.data[0];
    assert('Product has name', typeof p.name === 'string' && p.name.length > 0);
    assert('Product has price', typeof p.price?.current === 'number' && p.price.current > 0);
    assert('Product has chain', ['migros', 'coop'].includes(p.chain));
  }
}

// ─── Test 5: Price Comparison ───
async function testPriceComparison() {
  console.log('\n=== Test: Price Comparison ===');
  const result = await apiPost('/api/compare-prices', { query: 'butter', chains: ['migros', 'coop'] });

  assert('Returns ok:true', result.ok === true, JSON.stringify(result.error));
  assert('Has comparison data', result.data?.offers?.length > 0 || Array.isArray(result.data));
}

// ─── Test 6: Source Status ───
async function testSourceStatus() {
  console.log('\n=== Test: Source Status ===');
  const result = await apiGet('/api/source-status');

  assert('Returns ok:true', result.ok === true);
  assert('Has status data', Array.isArray(result.data));
  assert('Has at least 5 entries', result.data?.length >= 5);

  const migrosEntries = result.data?.filter(s => s.chain === 'migros');
  assert('Has Migros entries', migrosEntries?.length >= 1);

  const productSearchMigros = migrosEntries?.find(s => s.capability === 'productSearch');
  assert('Migros product search is live-beta', productSearchMigros?.status === 'live-beta');

  const storeSearchMigros = migrosEntries?.find(s => s.capability === 'storeSearch');
  assert('Migros store search is live-beta', storeSearchMigros?.status === 'live-beta');
}

// ─── Test 7: Product Availability (Products-First) ───
async function testProductAvailability() {
  console.log('\n=== Test: Product Availability (Products-First View) ===');
  const result = await apiPost('/api/product-availability', { query: 'milk', location: 'Zurich', chains: ['coop'], limit: 5 });

  assert('Returns ok:true', result.ok === true, JSON.stringify(result.error));

  if (result.ok && result.data?.length > 0) {
    const item = result.data[0];
    assert('Has product object', item.product != null, 'missing product');
    assert('Has stores array', Array.isArray(item.stores), 'missing stores');

    if (item.product) {
      assert('Product has name', typeof item.product.name === 'string');
      assert('Product has price', typeof item.product.price?.current === 'number');
    }

    if (item.stores?.length > 0) {
      const store = item.stores[0];
      assert('Store has chain', typeof store.chain === 'string');
      assert('Store has name', typeof store.name === 'string');
      assert('Store has available boolean', typeof store.available === 'boolean');
    }
  }
}

// ─── Test 8: Graceful Degradation - Unsupported Chains ───
async function testGracefulDegradation() {
  console.log('\n=== Test: Graceful Degradation ===');

  // Search with farmy (blocked)
  const resultFarmy = await apiPost('/api/search-products', { query: 'milk', chains: ['farmy'] });
  assert('Farmy returns ok:true (graceful)', resultFarmy.ok === true, JSON.stringify(resultFarmy.error));
  assert('Farmy returns empty data', resultFarmy.data?.length === 0);
  assert('Farmy has source warnings', resultFarmy.metadata?.sourceWarnings?.length > 0);
}

// ─── Test 9: Error Handling - Empty Query ───
async function testErrorHandling() {
  console.log('\n=== Test: Error Handling ===');

  const emptyQuery = await apiPost('/api/search-products', { query: '' });
  assert('Empty query returns ok:false', emptyQuery.ok === false);

  const emptyLocation = await apiPost('/api/find-stores', { location: '' });
  assert('Empty location returns ok:false', emptyLocation.ok === false);
}

// ─── Test 10: Nutrition Data Availability ───
async function testNutritionData() {
  console.log('\n=== Test: Nutrition Data ===');
  const result = await apiPost('/api/search-products', { query: 'apple juice', chains: ['migros'], limit: 5 });

  if (result.ok && result.data?.length > 0) {
    const withNutrition = result.data.filter(p => p.nutrition && p.nutrition.energyKcal !== undefined);
    assert('Some products have nutrition data', withNutrition.length > 0,
      `${withNutrition.length}/${result.data.length} have nutrition`);
  } else {
    console.log('  ⚠ No products found for nutrition test (skipped)');
  }
}

// ─── Test 11: Aldi Product Search ───
async function testAldiSearch() {
  console.log('\n=== Test: Aldi Product Search ===');
  const result = await apiPost('/api/search-products', { query: 'bread', chains: ['aldi'], limit: 5 });

  assert('Returns ok:true', result.ok === true, JSON.stringify(result.error));
  assert('Has product data', Array.isArray(result.data));

  if (result.data?.length > 0) {
    const p = result.data[0];
    assert('Product chain is aldi', p.chain === 'aldi');
    assert('Product has name', typeof p.name === 'string' && p.name.length > 0);
  }
}

// ─── Test 12: Denner Promotions ───
async function testDennerPromotions() {
  console.log('\n=== Test: Denner Promotions ===');
  const result = await apiPost('/api/search-products', { query: 'wine', chains: ['denner'], limit: 5 });

  assert('Returns ok:true', result.ok === true, JSON.stringify(result.error));
}

// ─── Test 13: Store Search with All Chains ───
async function testAllChainStoreSearch() {
  console.log('\n=== Test: All Chain Store Search ===');
  const result = await apiPost('/api/find-stores', { location: 'Geneva', limit: 20 });

  assert('Returns ok:true', result.ok === true, JSON.stringify(result.error));
  assert('Has store data', Array.isArray(result.data));

  if (result.data?.length > 0) {
    const chains = [...new Set(result.data.map(s => s.chain))];
    assert('Has at least 1 chain type', chains.length >= 1, `chains: ${chains.join(', ')}`);
  }
}

// ─── Test 14: Product Search with Max Price Filter ───
async function testMaxPriceFilter() {
  console.log('\n=== Test: Max Price Filter ===');
  const result = await apiPost('/api/search-products', { query: 'cheese', chains: ['migros'], maxPrice: 5, limit: 10 });

  assert('Returns ok:true', result.ok === true, JSON.stringify(result.error));

  if (result.ok && result.data?.length > 0) {
    const allUnderPrice = result.data.every(p => p.price.current <= 5);
    assert('All products under max price', allUnderPrice,
      `prices: ${result.data.map(p => p.price.current).join(', ')}`);
  }
}

// ─── Run All Tests ───
async function main() {
  console.log('=== Loop 1: Comprehensive SPA Test Cases ===\n');

  try {
    await testMigrosStoreSearch();
    await testCoopStoreSearch();
    await testMultiChainStoreSearch();
    await testProductSearch();
    await testPriceComparison();
    await testSourceStatus();
    await testProductAvailability();
    await testGracefulDegradation();
    await testErrorHandling();
    await testNutritionData();
    await testAldiSearch();
    await testDennerPromotions();
    await testAllChainStoreSearch();
    await testMaxPriceFilter();
  } catch (e) {
    console.error('FATAL ERROR:', e.message);
    failed++;
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(f));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
