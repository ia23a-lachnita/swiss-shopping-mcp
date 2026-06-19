/**
 * Manual test script for SPA endpoints.
 * Run: node scripts/test-spa-manual.mjs
 * Tests all vendors, postal codes, and edge cases.
 */

const BASE = 'http://localhost:3000';

const POSTAL_CODES = ['8001', '8303', '1003', '3001', '6003'];
const CHAINS = ['migros', 'coop', 'aldi', 'denner', 'lidl', 'ottos', 'volg'];

let passed = 0;
let failed = 0;
const issues = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    const msg = `  ✗ ${name}: ${e.message}`;
    console.log(msg);
    issues.push({ name, error: e.message });
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

async function postJSON(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    return { status: res.status, ...data };
  } catch {
    return { status: res.status, ok: false, error: text };
  }
}

async function getJSON(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  try {
    return { status: res.status, ...JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

// ── Product Search ──
console.log('\n=== Product Search ===');
for (const chain of CHAINS) {
  await test(`search "${chain}" chain for "apfel"`, async () => {
    const r = await postJSON('/api/search-products', { query: 'apfel', chains: [chain], limit: 5 });
    assert(r.ok === true, `ok=false: ${JSON.stringify(r)}`);
    assert(Array.isArray(r.data), 'data not array');
    console.log(`    → ${r.data.length} results`);
  });
}

await test('search empty query', async () => {
  const r = await postJSON('/api/search-products', { query: '', chains: ['migros'], limit: 5 });
  assert(r.ok === false || r.data?.length === 0, 'Should fail or return empty for empty query');
});

await test('search special characters', async () => {
  const r = await postJSON('/api/search-products', { query: '<script>alert(1)</script>', chains: ['migros'], limit: 5 });
  assert(r.ok === true, 'Should handle XSS attempt gracefully');
});

await test('search with maxPrice', async () => {
  const r = await postJSON('/api/search-products', { query: 'milch', chains: ['migros'], limit: 5, maxPrice: 1.0 });
  assert(r.ok === true, 'ok=false');
  r.data?.forEach(p => {
    if (p.price) assert(p.price <= 1.0, `Price ${p.price} > 1.0`);
  });
});

// ── Store Finder ──
console.log('\n=== Store Finder ===');
for (const code of POSTAL_CODES) {
  for (const chain of ['migros', 'coop']) {
    await test(`find stores "${chain}" near ${code}`, async () => {
      const r = await postJSON('/api/find-stores', { location: code, chains: [chain], limit: 10 });
      assert(r.ok === true, `ok=false: ${JSON.stringify(r)}`);
      assert(Array.isArray(r.data), 'data not array');
      console.log(`    → ${r.data.length} stores`);
    });
  }
}

await test('find stores unsupported chain (aldi)', async () => {
  const r = await postJSON('/api/find-stores', { location: '8001', chains: ['aldi'], limit: 10 });
  assert(r.ok === true, 'Should not error');
  console.log(`    → ${r.data?.length || 0} stores (expected 0)`);
});

await test('find stores unsupported chain (denner)', async () => {
  const r = await postJSON('/api/find-stores', { location: '8001', chains: ['denner'], limit: 10 });
  assert(r.ok === true, 'Should not error');
  console.log(`    → ${r.data?.length || 0} stores (expected 0)`);
});

// ── Store Availability ──
console.log('\n=== Store Availability ===');
for (const code of POSTAL_CODES) {
  for (const chain of ['migros', 'coop']) {
    await test(`availability "${chain}" for "apfel" near ${code}`, async () => {
      const r = await postJSON('/api/store-availability', { query: 'apfel', location: code, chains: [chain], limit: 10 });
      assert(r.ok === true, `ok=false: ${JSON.stringify(r)}`);
      assert(Array.isArray(r.data), 'data not array');
      const avail = r.data.filter(s => s.available);
      const open = r.data.filter(s => s.isOpen);
      console.log(`    → ${r.data.length} stores, ${avail.length} in stock, ${open.length} open`);
    });
  }
}

await test('availability with inStockOnly filter', async () => {
  const r = await postJSON('/api/store-availability', { query: 'apfel', location: '8001', chains: ['migros', 'coop'], limit: 10, inStockOnly: true });
  assert(r.ok === true, 'ok=false');
  r.data?.forEach(s => assert(s.available === true, `Store ${s.name} not in stock but returned`));
  console.log(`    → ${r.data?.length || 0} in-stock stores`);
});

await test('availability with openNow filter', async () => {
  const r = await postJSON('/api/store-availability', { query: 'apfel', location: '8001', chains: ['migros', 'coop'], limit: 10, openNow: true });
  assert(r.ok === true, 'ok=false');
  r.data?.forEach(s => assert(s.isOpen === true, `Store ${s.name} not open but returned`));
  console.log(`    → ${r.data?.length || 0} open stores`);
});

await test('availability all chains', async () => {
  const r = await postJSON('/api/store-availability', { query: 'apfel', location: '8001', chains: CHAINS, limit: 20 });
  assert(r.ok === true, 'ok=false');
  const byChain = {};
  r.data?.forEach(s => { byChain[s.chain] = (byChain[s.chain] || 0) + 1; });
  console.log(`    → ${r.data?.length || 0} stores: ${JSON.stringify(byChain)}`);
});

await test('availability empty location', async () => {
  const r = await postJSON('/api/store-availability', { query: 'apfel', location: '', chains: ['migros'], limit: 5 });
  assert(r.ok === false || r.data?.length === 0, 'Should fail or return empty for empty location');
});

await test('availability invalid postal code', async () => {
  const r = await postJSON('/api/store-availability', { query: 'apfel', location: '99999', chains: ['migros'], limit: 5 });
  assert(r.ok === true, 'Should not error');
  console.log(`    → ${r.data?.length || 0} stores (expected 0)`);
});

await test('availability nonexistent chain', async () => {
  const r = await postJSON('/api/store-availability', { query: 'apfel', location: '8001', chains: ['nonexistent'], limit: 5 });
  assert(r.ok === true, 'Should not error');
  console.log(`    → ${r.data?.length || 0} stores (expected 0)`);
});

// ── Source Status ──
console.log('\n=== Source Status ===');
await test('get source status', async () => {
  const r = await getJSON('/api/source-status');
  assert(r.ok === true, 'ok=false');
  assert(Array.isArray(r.data), 'data not array');
  console.log(`    → ${r.data?.length || 0} sources`);
});

// ── Price Comparison ──
console.log('\n=== Price Comparison ===');
await test('compare prices for "apfel"', async () => {
  const r = await postJSON('/api/compare-prices', { query: 'apfel', chains: ['migros', 'coop'], limit: 10 });
  assert(r.ok === true, `ok=false: ${JSON.stringify(r)}`);
  console.log(`    → ${r.data?.length || 0} products`);
});

// ── Static files ──
console.log('\n=== Static Files ===');
await test('GET / returns HTML', async () => {
  const r = await getJSON('/');
  assert(r.status === 200, `status ${r.status}`);
  assert(r.body.includes('Swiss Shopping MCP'), 'Missing title');
});

await test('GET /nonexistent returns 404', async () => {
  const r = await getJSON('/nonexistent');
  assert(r.status === 404, `Expected 404, got ${r.status}`);
});

// ── Summary ──
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (issues.length > 0) {
  console.log('\nIssues found:');
  issues.forEach(i => console.log(`  - ${i.name}: ${i.error}`));
  process.exit(1);
}
