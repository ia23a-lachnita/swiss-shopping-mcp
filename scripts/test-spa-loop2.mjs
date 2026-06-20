#!/usr/bin/env node
/**
 * Loop 2: Deep edge-case and regression testing
 * Focuses on:
 * 1. Edge cases in search (special chars, unicode, long queries)
 * 2. Store opening hours parsing correctness
 * 3. Opening hours isStoreOpen logic
 * 4. Product availability edge cases
 * 5. Concurrent request handling
 * 6. Missing/invalid parameters
 * 7. Chain-specific quirks (Otto's names, Denner 0 results, etc.)
 * 8. Response structure validation
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

// ─── Test: Edge Cases in Search ───
async function testSearchEdgeCases() {
  console.log('\n=== Test: Search Edge Cases ===');

  // Unicode query
  const unicode = await apiPost('/api/search-products', { query: 'Müesli', chains: ['migros'], limit: 3 });
  assert('Unicode query (Müesli) returns ok:true', unicode.ok === true);

  // Special characters
  const special = await apiPost('/api/search-products', { query: 'café & more!', chains: ['migros'], limit: 3 });
  assert('Special chars query returns ok:true', special.ok === true);

  // Very long query
  const longQuery = 'a'.repeat(200);
  const long = await apiPost('/api/search-products', { query: longQuery, chains: ['migros'], limit: 3 });
  assert('Very long query returns ok:true or ok:false gracefully', long.ok !== undefined);

  // Whitespace-only query
  const whitespace = await apiPost('/api/search-products', { query: '   ', chains: ['migros'], limit: 3 });
  assert('Whitespace-only query returns ok:false', whitespace.ok === false);

  // Numbers-only query
  const numbers = await apiPost('/api/search-products', { query: '12345', chains: ['migros'], limit: 3 });
  assert('Numbers-only query returns ok:true', numbers.ok === true);

  // Single char query
  const single = await apiPost('/api/search-products', { query: 'a', chains: ['migros'], limit: 3 });
  assert('Single char query returns ok:true', single.ok === true);
}

// ─── Test: Store Opening Hours ───
async function testStoreOpeningHours() {
  console.log('\n=== Test: Store Opening Hours ===');

  const result = await apiPost('/api/find-stores', { location: 'Bern', chains: ['migros'], limit: 10 });

  if (result.ok && result.data?.length > 0) {
    let storesWithHours = 0;
    let storesWithWeekday = 0;

    for (const store of result.data) {
      if (store.openingHours) {
        storesWithHours++;
        const hasWeekday = store.openingHours.includes('Mon-Fri');
        const hasWeekend = store.openingHours.includes('Sat-Sun');
        const hasTimeRange = /\d{1,2}:\d{2}/.test(store.openingHours);

        if (hasWeekday || hasWeekend) storesWithWeekday++;

        assert(`Store "${store.name}" has structured hours`,
          hasWeekday || hasWeekend,
          `hours: ${store.openingHours}`);

        if (hasTimeRange) {
          assert(`Store "${store.name}" hours contain time ranges`,
            /\d{1,2}:\d{2}-\d{1,2}:\d{2}/.test(store.openingHours),
            `hours: ${store.openingHours}`);
        }
      }
    }

    assert('At least 1 store has opening hours', storesWithHours > 0, `found ${storesWithHours}`);
    assert('At least 1 store has weekday/weekend format', storesWithWeekday > 0, `found ${storesWithWeekday}`);
  }
}

// ─── Test: isStoreOpen Logic ───
async function testIsStoreOpen() {
  console.log('\n=== Test: isStoreOpen Logic ===');

  // Test with Zurich (Coop has simple "07:30 - 21:00" format)
  const result = await apiPost('/api/find-stores', { location: 'Zurich', chains: ['coop'], limit: 5 });

  if (result.ok && result.data?.length > 0) {
    const storesWithHours = result.data.filter(s => s.openingHours && s.openingHours !== 'Geschlossen');
    assert('Coop stores have hours or closed status', storesWithHours.length > 0 || result.data.some(s => s.openingHours === 'Geschlossen'));

    if (storesWithHours.length > 0) {
      const store = storesWithHours[0];
      assert(`Coop store hours "${store.openingHours}" is parseable`,
        /\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/.test(store.openingHours));
    }
  }
}

// ─── Test: Product Availability Edge Cases ───
async function testAvailabilityEdgeCases() {
  console.log('\n=== Test: Product Availability Edge Cases ===');

  // No location
  const noLocation = await apiPost('/api/product-availability', { query: 'milk' });
  assert('Missing location returns ok:false', noLocation.ok === false);

  // No query
  const noQuery = await apiPost('/api/product-availability', { location: 'Zurich' });
  assert('Missing query returns ok:false', noQuery.ok === false);

  // Empty location
  const emptyLoc = await apiPost('/api/product-availability', { query: 'milk', location: '' });
  assert('Empty location returns ok:false', emptyLoc.ok === false);

  // Valid with unsupported chain
  const unsupportedChain = await apiPost('/api/product-availability', { query: 'milk', location: 'Zurich', chains: ['farmy'] });
  assert('Unsupported chain returns ok:false or ok:true with empty', unsupportedChain.ok !== undefined);

  // Store availability endpoint (old) still works
  const storeAvail = await apiPost('/api/store-availability', { query: 'milk', location: 'Zurich', chains: ['coop'], limit: 3 });
  assert('Old store-availability endpoint still works', storeAvail.ok !== undefined);
}

// ─── Test: Chain-specific Quirks ───
async function testChainQuirks() {
  console.log('\n=== Test: Chain-specific Quirks ===');

  // Otto's - names should be "Otto's {town}" format, not numeric
  const ottos = await apiPost('/api/find-stores', { location: 'Zurich', chains: ['ottos'], limit: 5 });
  if (ottos.ok && ottos.data?.length > 0) {
    for (const store of ottos.data) {
      assert(`Otto's store name not numeric: "${store.name}"`,
        !/^\d+$/.test(store.name),
        `name: ${store.name}`);
    }
  }

  // Denner - product search works
  const denner = await apiPost('/api/search-products', { query: 'wine', chains: ['denner'], limit: 3 });
  assert('Denner product search returns ok:true', denner.ok === true);

  // Lidl - store search works
  const lidl = await apiPost('/api/find-stores', { location: 'Zurich', chains: ['lidl'], limit: 3 });
  assert('Lidl store search returns ok:true', lidl.ok === true);
  if (lidl.ok && lidl.data?.length > 0) {
    assert('Lidl stores have chain=lidl', lidl.data[0].chain === 'lidl');
  }

  // Volg - store search works
  const volg = await apiPost('/api/find-stores', { location: 'Bern', chains: ['volg'], limit: 3 });
  assert('Volg store search returns ok:true', volg.ok === true);
}

// ─── Test: Response Structure Validation ───
async function testResponseStructure() {
  console.log('\n=== Test: Response Structure ===');

  // Product search response structure
  const products = await apiPost('/api/search-products', { query: 'cheese', chains: ['migros'], limit: 3 });
  if (products.ok && products.data?.length > 0) {
    const p = products.data[0];
    assert('Product has id field', p.id !== undefined);
    assert('Product has name field', typeof p.name === 'string');
    assert('Product has chain field', typeof p.chain === 'string');
    assert('Product has price.current', typeof p.price?.current === 'number');
    assert('Product has provenance', p.provenance !== undefined);
    if (p.provenance) {
      assert('Provenance has provider', typeof p.provenance.provider === 'string');
      assert('Provenance has freshness', typeof p.provenance.freshness === 'string');
    }
  }

  // Store search response structure
  const stores = await apiPost('/api/find-stores', { location: 'Zurich', chains: ['coop'], limit: 3 });
  if (stores.ok && stores.data?.length > 0) {
    const s = stores.data[0];
    assert('Store has id field', s.id !== undefined);
    assert('Store has name field', typeof s.name === 'string');
    assert('Store has chain field', typeof s.chain === 'string');
    assert('Store has location', s.location !== undefined);
    if (s.location) {
      assert('Location has latitude', typeof s.location.latitude === 'number');
      assert('Location has longitude', typeof s.location.longitude === 'number');
    }
  }

  // Source status response structure
  const status = await apiGet('/api/source-status');
  if (status.ok && status.data?.length > 0) {
    const s = status.data[0];
    assert('Status has chain field', typeof s.chain === 'string');
    assert('Status has capability field', typeof s.capability === 'string');
    assert('Status has status field', typeof s.status === 'string');
  }
}

// ─── Test: Concurrent Requests ───
async function testConcurrentRequests() {
  console.log('\n=== Test: Concurrent Requests ===');

  const queries = ['milk', 'bread', 'cheese', 'butter', 'eggs'];
  const results = await Promise.all(
    queries.map(q => apiPost('/api/search-products', { query: q, chains: ['migros'], limit: 3 }))
  );

  const allOk = results.every(r => r.ok === true);
  assert('5 concurrent search queries all succeed', allOk);

  const allHaveData = results.every(r => Array.isArray(r.data));
  assert('All concurrent results have data arrays', allHaveData);
}

// ─── Test: Price Comparison Edge Cases ───
async function testPriceComparisonEdgeCases() {
  console.log('\n=== Test: Price Comparison Edge Cases ===');

  // Single chain
  const single = await apiPost('/api/compare-prices', { query: 'milk', chains: ['migros'] });
  assert('Single chain comparison works', single.ok === true);

  // All chains
  const all = await apiPost('/api/compare-prices', { query: 'butter' });
  assert('All chains comparison works', all.ok === true);

  // With quantity
  const qty = await apiPost('/api/compare-prices', { query: 'milk', chains: ['migros', 'coop'], quantity: 3 });
  assert('Comparison with quantity works', qty.ok === true);
}

// ─── Test: Search Products with Various Limits ───
async function testSearchLimits() {
  console.log('\n=== Test: Search Limits ===');

  const limit1 = await apiPost('/api/search-products', { query: 'milk', chains: ['migros'], limit: 1 });
  if (limit1.ok) {
    assert('Limit 1 returns at most 1 product', limit1.data?.length <= 1, `got ${limit1.data?.length}`);
  }

  const limit20 = await apiPost('/api/search-products', { query: 'milk', chains: ['migros'], limit: 20 });
  if (limit20.ok) {
    assert('Limit 20 returns up to 20 products', limit20.data?.length <= 20, `got ${limit20.data?.length}`);
  }
}

// ─── Test: Product Search with No Chain Filter ───
async function testNoChainFilter() {
  console.log('\n=== Test: No Chain Filter ===');

  const result = await apiPost('/api/search-products', { query: 'milk', limit: 10 });
  assert('No chain filter returns ok:true', result.ok === true);
  if (result.ok) {
    const chains = [...new Set(result.data?.map(p => p.chain))];
    assert('Results come from multiple chains', chains.length >= 2, `chains: ${chains.join(', ')}`);
  }
}

// ─── Run All Tests ───
async function main() {
  console.log('=== Loop 2: Deep Edge-Case and Regression Testing ===\n');

  try {
    await testSearchEdgeCases();
    await testStoreOpeningHours();
    await testIsStoreOpen();
    await testAvailabilityEdgeCases();
    await testChainQuirks();
    await testResponseStructure();
    await testConcurrentRequests();
    await testPriceComparisonEdgeCases();
    await testSearchLimits();
    await testNoChainFilter();
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
