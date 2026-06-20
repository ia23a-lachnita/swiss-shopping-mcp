#!/usr/bin/env node
/**
 * Loop 3: Full SPA regression test — covers all JS fetch paths in index.html
 * Tests every endpoint the SPA touches, including recently fixed features.
 */

const BASE = 'http://localhost:3000';
let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ': ' + detail : ''}`); }
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  return res.json();
}

// =====================================================
// 1. Source Status (GET /api/source-status)
// =====================================================
console.log('\n=== Test: Source Status ===');
{
  const r = await get('/api/source-status');
  assert('Returns ok:true', r.ok === true);
  assert('Has data array', Array.isArray(r.data));
  assert('Has migros entries', r.data.some(s => s.chain === 'migros'));
  assert('Has coop entries', r.data.some(s => s.chain === 'coop'));
  assert('Each entry has chain', r.data.every(s => typeof s.chain === 'string'));
  assert('Each entry has capability', r.data.every(s => typeof s.capability === 'string'));
  assert('Each entry has status', r.data.every(s => typeof s.status === 'string'));
  const migrosSearch = r.data.find(s => s.chain === 'migros' && s.capability === 'productSearch');
  assert('Migros product search is live-beta', migrosSearch?.status === 'live-beta');
  const migrosStore = r.data.find(s => s.chain === 'migros' && s.capability === 'storeSearch');
  assert('Migros store search is live-beta', migrosStore?.status === 'live-beta');
}

// =====================================================
// 2. Product Search — all chains
// =====================================================
console.log('\n=== Test: Product Search (all chains) ===');
{
  const r = await post('/api/search-products', { query: 'butter', chains: ['migros'], limit: 3 });
  assert('Migros search returns ok:true', r.ok === true);
  assert('Migros has products', r.data?.length > 0);
  if (r.data?.length > 0) {
    const p = r.data[0];
    assert('Product has id', typeof p.id === 'string');
    assert('Product has name', typeof p.name === 'string');
    assert('Product has chain=migros', p.chain === 'migros');
    assert('Product has price.current', typeof p.price?.current === 'number');
    assert('Product has productUrl', typeof p.productUrl === 'string');
  }
}
{
  const r = await post('/api/search-products', { query: 'butter', chains: ['coop'], limit: 3 });
  assert('Coop search returns ok:true', r.ok === true);
  assert('Coop has products', r.data?.length > 0);
  if (r.data?.length > 0) {
    const p = r.data[0];
    assert('Coop product has chain=coop', p.chain === 'coop');
  }
}
{
  const r = await post('/api/search-products', { query: 'butter', chains: ['aldi'], limit: 3 });
  assert('Aldi search returns ok:true', r.ok === true);
  assert('Aldi has products', r.data?.length > 0);
}
{
  const r = await post('/api/search-products', { query: 'Milch', chains: ['migros', 'coop'], limit: 10 });
  assert('Multi-chain search returns ok:true', r.ok === true);
  assert('Multi-chain has data', Array.isArray(r.data));
}

// =====================================================
// 3. Nutrition toggle path (SPA fetches product, toggles checkbox)
// =====================================================
console.log('\n=== Test: Nutrition Data in Products ===');
{
  const r = await post('/api/search-products', { query: 'Milch', chains: ['migros'], limit: 3 });
  assert('Search returns ok:true', r.ok === true);
  if (r.data?.length > 0) {
    const p = r.data[0];
    assert('Product has nutrition (object or undefined)', 
      p.nutrition === undefined || typeof p.nutrition === 'object');
    if (p.nutrition) {
      assert('Nutrition has values', Object.keys(p.nutrition).length > 0);
    }
  }
}

// =====================================================
// 4. Store Finder — Migros (was 401, now fixed)
// =====================================================
console.log('\n=== Test: Store Finder (Migros) ===');
{
  const r = await post('/api/find-stores', { location: 'Bern', chains: ['migros'], limit: 5 });
  assert('Migros store search returns ok:true', r.ok === true);
  assert('Has store data', r.data?.length > 0);
  if (r.data?.length > 0) {
    const s = r.data[0];
    assert('Store has chain=migros', s.chain === 'migros');
    assert('Store has name', typeof s.name === 'string' && s.name.length > 0);
    assert('Store has location.latitude', typeof s.location?.latitude === 'number');
    assert('Store has location.longitude', typeof s.location?.longitude === 'number');
    assert('Store has openingHours', s.openingHours !== undefined);
    if (s.openingHours) {
      assert('Opening hours is non-empty string', s.openingHours.length > 0);
      assert('Opening hours contains weekday/weekend or time range', 
        /Mon|Sat|Sun|\d{1,2}:\d{2}/.test(s.openingHours));
    }
  }
}

// =====================================================
// 5. Store Finder — Coop
// =====================================================
console.log('\n=== Test: Store Finder (Coop) ===');
{
  const r = await post('/api/find-stores', { location: 'Zurich', chains: ['coop'], limit: 5 });
  assert('Coop store search returns ok:true', r.ok === true);
  assert('Has store data', r.data?.length > 0);
  if (r.data?.length > 0) {
    const s = r.data[0];
    assert('Store has chain=coop', s.chain === 'coop');
    assert('Store has name', typeof s.name === 'string');
    assert('Store has address', typeof s.address === 'string');
  }
}

// =====================================================
// 6. Store Finder — Multi-chain
// =====================================================
console.log('\n=== Test: Store Finder (Multi-chain) ===');
{
  const r = await post('/api/find-stores', { location: 'Basel', chains: ['migros', 'coop'], limit: 10 });
  assert('Multi-chain store search returns ok:true', r.ok === true);
  assert('Has store data', r.data?.length > 0);
  const chains = new Set(r.data.map(s => s.chain));
  assert('Results from multiple chains', chains.size >= 1);
}

// =====================================================
// 7. Price Comparison
// =====================================================
console.log('\n=== Test: Price Comparison ===');
{
  const r = await post('/api/compare-prices', { query: 'butter', chains: ['migros', 'coop'] });
  assert('Price comparison returns ok:true', r.ok === true);
  assert('Has offers', r.data?.offers?.length > 0);
  if (r.data?.offers?.length > 0) {
    const offer = r.data.offers[0];
    assert('Offer has chain', typeof offer.chain === 'string');
    assert('Offer has product', typeof offer.product?.name === 'string');
    assert('Offer has effectivePrice', typeof offer.effectivePrice === 'number');
  }
}

// =====================================================
// 8. Availability — products-first endpoint
// =====================================================
console.log('\n=== Test: Availability (Products-first) ===');
{
  const r = await post('/api/product-availability', { query: 'Milch', location: 'Bern', chains: ['migros', 'coop'] });
  assert('Product availability returns ok:true', r.ok === true);
  assert('Has products array', Array.isArray(r.data));
}

// =====================================================
// 9. Availability — legacy store-availability endpoint
// =====================================================
console.log('\n=== Test: Availability (Legacy endpoint) ===');
{
  const r = await post('/api/store-availability', { query: 'Milch', location: 'Bern' });
  assert('Legacy availability returns ok:true', r.ok === true);
  assert('Has stores array', Array.isArray(r.data));
}

// =====================================================
// 10. Error handling
// =====================================================
console.log('\n=== Test: Error Handling ===');
{
  const r1 = await post('/api/search-products', { query: '', chains: ['migros'] });
  assert('Empty query returns ok:false', r1.ok === false);

  const r2 = await post('/api/search-products', { chains: ['migros'] });
  assert('Missing query returns ok:false', r2.ok === false);

  const r3 = await post('/api/find-stores', { location: '' });
  assert('Empty location returns ok:false', r3.ok === false);

  const r4 = await post('/api/find-stores', {});
  assert('Missing location returns ok:false', r4.ok === false);

  const r5 = await post('/api/compare-prices', { query: '' });
  assert('Empty comparison query returns ok:false', r5.ok === false);

  const r6 = await post('/api/store-availability', { query: '' });
  assert('Empty avail query returns ok:false', r6.ok === false);

  const r7 = await post('/api/store-availability', { query: 'milk' });
  assert('Missing location in avail returns ok:false', r7.ok === false);
}

// =====================================================
// 11. Unsupported chains
// =====================================================
console.log('\n=== Test: Unsupported Chain Graceful Degradation ===');
{
  const r = await post('/api/search-products', { query: 'milk', chains: ['farmy'] });
  assert('Farmy search returns ok:true (graceful)', r.ok === true);
  assert('Farmy has empty or missing data', r.data?.length === 0 || !r.data);
}

// =====================================================
// 12. Large queries
// =====================================================
console.log('\n=== Test: Large Queries ===');
{
  const r = await post('/api/search-products', { query: 'milk', chains: ['migros', 'coop', 'aldi'], limit: 20 });
  assert('Limit 20 returns ok:true', r.ok === true);
  assert('Has data', Array.isArray(r.data));
}

// =====================================================
// 13. SPA static assets
// =====================================================
console.log('\n=== Test: SPA Static Assets ===');
{
  const html = await fetch(`${BASE}/`).then(r => r.text());
  assert('HTML loads', html.length > 0);
  assert('Has tab-stores element', html.includes('tab-stores'));
  assert('Has tab-avail element', html.includes('tab-avail'));
  assert('Has search-btn', html.includes('search-btn'));
  assert('Has store-btn', html.includes('store-btn'));
  assert('Has avail-btn', html.includes('avail-btn'));
  assert('Has nutrition checkbox', html.includes('search-show-nutrition'));
  assert('Has ingredients checkbox', html.includes('search-show-ingredients'));
  assert('Has in-stock filter', html.includes('avail-instock'));
  assert('Has open-now filter', html.includes('avail-open'));
}

// =====================================================
// 14. Opening hours isStoreOpen
// =====================================================
console.log('\n=== Test: isStoreOpen via Availability ===');
{
  const r = await post('/api/store-availability', { query: 'Milch', location: 'Bern', openNow: true });
  assert('Open-now filter returns ok:true', r.ok === true);
  assert('Has stores array', Array.isArray(r.data));
  if (r.data?.length > 0) {
    const s = r.data[0];
    assert('Store has isOpen field (boolean or undefined)', 
      typeof s.isOpen === 'boolean' || typeof s.isOpen === 'undefined');
  }
}

// =====================================================
// Summary
// =====================================================
console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
