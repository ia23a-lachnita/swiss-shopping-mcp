/**
 * Capture the merged candidate pool for every golden query against the live
 * vendor fan-out, so the relevance suite can score a ranker deterministically
 * without hitting the network.
 *
 * Run from the repo root after `npm run build`:
 *   node scripts/captureGoldenFixtures.mjs [--only <id>[,<id>...]] [--web]
 *
 * Two tiers:
 *   default  raw vendor fan-out          -> src/eval/fixtures/
 *   --web    plus web-search augmentation -> src/eval/fixtures-web/
 *
 * The web tier exists because augmentation injects web-discovered products at
 * the *head* of the merged list, ahead of everything the adapters returned, so
 * it can put a product in the top 5 that the vendor tier never saw. It needs
 * provider API keys in the environment.
 *
 * The local SQLite catalog is deliberately excluded from both tiers: its
 * contents are environment-specific (a few hundred rows here, a different set
 * on the Pi), so fixtures captured against it would not be reproducible.
 *
 * Fixtures are snapshots of a live catalogue and WILL drift. Re-capture
 * deliberately (and review the diff), never automatically as part of a test
 * run — a fixture silently re-recorded to match new behaviour proves nothing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const withWeb = process.argv.includes('--web');
const outDir = join(repoRoot, 'src', 'eval', withWeb ? 'fixtures-web' : 'fixtures');

const { createDefaultAdapters } = await import('../dist/adapters/index.js');
const { SearchService } = await import('../dist/services/searchService.js');
const { createDefaultWebProductSearch } = await import(
  '../dist/services/webProductSearchService.js'
);
const { chainTimeoutMs } = await import('../dist/util/timeout.js');
const { GOLDEN_QUERIES, WEB_TIER_QUERY_IDS } = await import('../dist/eval/goldenSet.js');

// Comma-separated, because the honest way to re-capture after a change to
// query understanding is to re-capture exactly the queries that change and
// leave the rest frozen — otherwise vendor drift lands in the same diff and
// nobody can tell which moved the numbers.
const onlyIndex = process.argv.indexOf('--only');
const only =
  onlyIndex >= 0
    ? new Set(
        (process.argv[onlyIndex + 1] ?? '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      )
    : undefined;

/**
 * Per-chain record of what the vendor adapters returned during the current
 * query, so the web tier can tell whether augmentation actually contributed
 * something rather than whether a *previously committed* fixture happens to
 * differ.
 *
 * This used to be decided by diffing against the committed vendor fixture on
 * disk, which silently meant "differs from whatever was captured last time, on
 * whatever machine, however long ago". That held only while both tiers were
 * captured minutes apart on one machine. The web tier has to be captured from
 * an egress DuckDuckGo serves (the Pi), days after the vendor tier and from a
 * different network, at which point vendor drift and the egress change both
 * read as `augmented: true` — the guard would pass while asserting nothing,
 * which is the exact failure it exists to prevent, with the opposite sign.
 *
 * Recording inside the same call removes the comparison from the network
 * entirely: one fan-out, one pool, no jitter to mistake for augmentation.
 */
const recordedByChain = new Map();

/**
 * Proxy rather than `{...adapter}`: adapters come from factories whose shape is
 * theirs to choose, and object spread copies only own enumerable properties —
 * it would drop prototype methods and rebind `this` away from the instance.
 */
function withVendorRecording(adapter) {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop !== 'searchProducts') return Reflect.get(target, prop, receiver);
      return async (...args) => {
        const started = Date.now();
        const result = await target.searchProducts(...args);
        if (result?.ok) {
          recordedByChain.set(target.chain, {
            products: result.data,
            elapsedMs: Date.now() - started,
          });
        }
        return result;
      };
    },
  });
}

// Vendor tier is left exactly as it was — it has no augmentation to detect,
// and wrapping it would put a proxy in the path of the one tier that is the
// project's committed baseline.
const adapters = withWeb
  ? createDefaultAdapters().map(withVendorRecording)
  : createDefaultAdapters();
/**
 * Whether augmentation was even attempted for the current query, and for which
 * chains.
 *
 * `SearchService` only reaches for the web when a chain's vendor results are
 * weak (`shouldRunWebSearch`: fewer than 3 products, or too few carrying a
 * price). So "nothing was added" has three very different causes — the web
 * step never ran, it ran and the provider failed, or it ran fine and found
 * nothing new — and only the middle one is fixed by capturing from a different
 * egress. Recording the call itself separates them without reimplementing the
 * weakness rule, which would then be free to drift from the real one.
 */
let webAttempt;

let webProductSearch;
if (withWeb) {
  webProductSearch = createDefaultWebProductSearch(adapters, {});
  if (!webProductSearch) {
    console.error(
      'Web search unavailable — set a provider key (and do not set SWISS_SHOPPING_WEB_SEARCH=off).'
    );
    process.exit(1);
  }
  webProductSearch = new Proxy(webProductSearch, {
    get(target, prop, receiver) {
      if (prop !== 'searchProducts') return Reflect.get(target, prop, receiver);
      return async (filters, chains) => {
        webAttempt = { chains: [...chains], products: 0 };
        const result = await target.searchProducts(filters, chains);
        webAttempt.products = Object.values(result?.productsByChain ?? {}).reduce(
          (total, list) => total + list.length,
          0
        );
        return result;
      };
    },
  });
}
// No breaker and no cache in either tier: the fixture must be the candidate
// pool the adapters actually produced, not a cache artefact.
const service = new SearchService(adapters, { webProductSearch });
console.log(withWeb ? 'Tier: vendor + web augmentation' : 'Tier: raw vendor fan-out');

mkdirSync(outDir, { recursive: true });

const inScope = withWeb
  ? GOLDEN_QUERIES.filter((q) => WEB_TIER_QUERY_IDS.includes(q.id))
  : GOLDEN_QUERIES;
const queries = only ? inScope.filter((q) => only.has(q.id)) : inScope;
console.log(`Capturing ${queries.length} queries...`);

// Matches how the eval judges a product (name + brand, never category or
// tags), so "added" means added as far as scoring can tell. Chains repeat
// names freely — Migros lists four distinct Milchdrinks all called
// "Milchdrink" — so a web product sharing a name with a vendor one reads as
// already present. That under-reports augmentation rather than over-reporting
// it, which is the safe direction for a gate that refuses hollow fixtures.
const keyOf = (product) => `${product.chain}|${product.name}`;

/**
 * The vendor-only pool for the call that just ran, as the set of product keys
 * `SearchService` itself would have merged.
 *
 * A chain that overran its budget is excluded, because `SearchService` races
 * every adapter against `chainTimeoutMs` and drops the losers — but the losing
 * promise keeps running and still resolves into our proxy. Counting it would
 * make the baseline a superset of the real pool, and a web-discovered product
 * that the late chain also returned would then read as vendor-origin. The
 * production timeout function is imported rather than reimplemented so the two
 * cannot drift apart.
 */
function vendorKeysFromRun() {
  const keys = new Set();
  for (const [chain, record] of recordedByChain) {
    if (record.elapsedMs > chainTimeoutMs(chain)) continue;
    for (const product of record.products) keys.add(keyOf(product));
  }
  return keys;
}

const summary = [];

for (const golden of queries) {
  process.stdout.write(`  ${golden.id.padEnd(28)} `);
  const started = Date.now();
  let products = [];
  let error;
  let webWarnings = [];
  recordedByChain.clear();
  webAttempt = undefined;
  try {
    const result = await service.searchProducts({ query: golden.query, limit: 40 });
    // Distinguishes "the provider was unreachable" from "the provider answered
    // and had nothing to add" — without this, both land as `augmented: false`
    // and a blocked egress looks identical to an unhelpful one.
    webWarnings = (result.metadata?.sourceWarnings ?? [])
      .filter((warning) => warning.provider === 'WebSearch')
      .map((warning) => warning.message);
    products = (result.data ?? []).map((p) => ({
      chain: p.chain,
      name: p.name,
      brand: p.brand ?? null,
      category: p.category ?? null,
      tags: p.tags ?? [],
      price: p.price?.current ?? null,
      unit: p.unit ?? null,
    }));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const elapsed = Date.now() - started;

  // Whether augmentation actually contributed, recorded per fixture. Without
  // this the web tier degrades into a copy of the vendor tier the moment the
  // provider is rate-limited or its breaker opens, and nothing says so.
  //
  // Named rather than counted: the point of the web tier is that augmentation
  // injects at the *head* of the merged list, so it can put a product in the
  // top 5 the vendor fan-out never saw. Which products those were is the whole
  // claim the fixture is making, and a bare boolean makes it unreviewable.
  let augmented;
  let addedByWeb;
  if (withWeb) {
    const vendorKeys = vendorKeysFromRun();
    addedByWeb = products.filter((p) => !vendorKeys.has(keyOf(p))).map((p) => keyOf(p));
    augmented = addedByWeb.length > 0;
  }

  console.log(
    error
      ? `ERROR ${error}`
      : `${products.length} products (${elapsed}ms)` +
          (withWeb
            ? augmented
              ? ` [augmented: +${addedByWeb.length}]`
              : ` [NOT augmented]${webWarnings.length > 0 ? ` — ${webWarnings[0]}` : ''}`
            : '')
  );

  // A fixture that records no augmentation asserts nothing about the path it
  // exists to cover, and the suite rejects it on sight. Writing it anyway just
  // creates a file whose only possible use is to be committed by mistake.
  if (withWeb && !augmented) {
    summary.push({
      id: golden.id,
      count: products.length,
      error,
      augmented,
      webWarnings,
      webAttempt,
      skipped: true,
    });
    continue;
  }

  writeFileSync(
    join(outDir, `${golden.id}.json`),
    `${JSON.stringify(
      {
        id: golden.id,
        query: golden.query,
        capturedAt: new Date().toISOString(),
        augmented,
        ...(withWeb ? { addedByWeb } : {}),
        products,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  summary.push({ id: golden.id, count: products.length, error, augmented, webWarnings });
}

const empty = summary.filter((s) => s.count === 0);
console.log(`\nCaptured ${summary.length} fixtures; ${empty.length} empty.`);
if (empty.length) console.log('Empty:', empty.map((s) => s.id).join(', '));

if (withWeb) {
  const notAugmented = summary.filter((s) => !s.augmented);
  if (notAugmented.length > 0) {
    console.log(
      `\nWeb augmentation contributed nothing for ${notAugmented.length}/${summary.length}; no fixture written for these:`
    );
    let neverRan = 0;
    for (const entry of notAugmented) {
      // Three different causes, only one of which a different egress fixes.
      let reason;
      if (!entry.webAttempt) {
        neverRan += 1;
        reason = 'web step never ran — vendor results were strong for every chain';
      } else if (entry.webWarnings?.length > 0) {
        reason = `provider failed — ${entry.webWarnings[0]}`;
      } else {
        reason = `provider returned ${entry.webAttempt.products} products, none new (chains: ${entry.webAttempt.chains.join(', ')})`;
      }
      console.log(`  ${entry.id.padEnd(24)} ${reason}`);
    }
    console.log(
      `\nThe breaker opens after 3 failures and stays open 5 minutes, so one blocked query\n` +
        `can suppress the rest of the run — check whether the warnings above are all the same.`
    );
    if (neverRan > 0) {
      console.log(
        `\n${neverRan} quer${neverRan === 1 ? 'y' : 'ies'} never reached the web step at all. That is not an\n` +
          `egress problem and will not change on another machine: SearchService only augments\n` +
          `chains whose vendor results are weak. Such a query cannot produce a web fixture, so\n` +
          `it does not belong in WEB_TIER_QUERY_IDS.`
      );
    }
    // Non-zero so a CI run cannot look green while producing a partial tier.
    // The artifact upload still runs; this is a signal, not a teardown.
    process.exit(1);
  }
}
process.exit(0);
