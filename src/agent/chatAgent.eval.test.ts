// Golden-eval layer (see docs/active/CHAT_AGENT_ARCHITECTURE_PLAN.md
// "Testing"): hand-rolled fixtures asserting tool SELECTION against the real
// chosen model, not response prose. Catches "I tweaked the system prompt and
// the model quietly stopped calling search_products" — a class of regression
// the mock-model unit tests structurally cannot see (a mock always returns
// what the test told it to). Opt-in: costs real OpenRouter free-tier
// requests, not run in the default `npm test` / CI path.
//
// Run with: RUN_AGENT_EVAL=1 npm test -- --run chatAgent.eval.test.ts
// (or `npm run test:eval` once OPENROUTER_API_KEY is set in the shell)
import { describe, expect, it } from 'vitest';

import { Chain, ChainAdapter, NormalizedProduct, ProductSearchFilters, Result } from '../adapters/types.js';
import { PriceComparisonService } from '../services/priceComparisonService.js';
import { SearchService } from '../services/searchService.js';
import { ToolDependencies } from '../tools/handlers.js';
import { runChatAgent } from './chatAgent.js';

function fixtureAdapter(chain: Chain): ChainAdapter {
  const products: NormalizedProduct[] = [
    { id: `${chain}-milch`, chain, name: 'Vollmilch 1L', price: { current: 1.5 } },
    { id: `${chain}-hack`, chain, name: 'Rindshackfleisch 500g', price: { current: 6.9 } },
    { id: `${chain}-zahnpasta`, chain, name: 'Zahnpasta sensitive', price: { current: 3.2 } },
    { id: `${chain}-brot`, chain, name: 'Bio Vollkornbrot', price: { current: 2.8 } },
    { id: `${chain}-kaese`, chain, name: 'Gruyère AOP 200g', price: { current: 5.5 } },
  ];
  return {
    chain,
    async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
      return { ok: true, data: products.slice(0, filters.limit) };
    },
    async searchPromotions(filters) {
      return {
        ok: true,
        data: products.slice(0, filters.limit).map((p) => ({
          id: p.id,
          chain,
          title: `${p.name} im Angebot`,
          productName: p.name,
          price: p.price,
          validFrom: new Date(),
          validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        })),
      };
    },
    async findStores(filters) {
      return {
        ok: true,
        data: [
          {
            id: `${chain}-store-1`,
            chain,
            name: `${chain} ${filters.location}`,
            address: `Bahnhofstrasse 1, ${filters.location}`,
            location: { latitude: 47.37, longitude: 8.54 },
          },
        ].slice(0, filters.limit),
      };
    },
    getStoreAvailabilitySupport() {
      return { chain, supported: chain === 'migros' || chain === 'coop' };
    },
    async lookupStoreProductAvailability(filters) {
      return {
        ok: true,
        data: { chain, storeId: filters.storeId, query: filters.query, supported: false, matches: [], isAvailable: false },
      };
    },
  };
}

function dependencies(): ToolDependencies {
  const adapters = (['migros', 'coop', 'aldi', 'denner'] as const).map(fixtureAdapter);
  return {
    searchService: new SearchService(adapters),
    priceComparisonService: new PriceComparisonService(adapters),
  };
}

interface Fixture {
  prompt: string;
  expectedTool: string | null;
  /** Loose substring check on the JSON-stringified first-step tool input, when a tool call is expected. */
  expectedInputContains?: string;
}

const FIXTURES: Fixture[] = [
  { prompt: 'Wo finde ich günstige Vollmilch?', expectedTool: 'search_products', expectedInputContains: 'milch' },
  {
    prompt: 'Vergleiche die Preise für Rindshackfleisch zwischen den Ketten',
    expectedTool: 'compare_prices',
    expectedInputContains: 'hack',
  },
  { prompt: 'Finde eine Migros Filiale in Zürich', expectedTool: 'find_stores', expectedInputContains: 'rich' },
  { prompt: 'Aktuelle Angebote bei Denner', expectedTool: 'search_promotions' },
  { prompt: 'Was ist die Hauptstadt der Schweiz?', expectedTool: null },
  { prompt: 'Erzähl mir einen Witz.', expectedTool: null },
  { prompt: 'Où puis-je trouver du pain bio ?', expectedTool: 'search_products', expectedInputContains: 'pain' },
  { prompt: 'Confronta i prezzi del formaggio', expectedTool: 'compare_prices' },
  { prompt: 'Gibt es Zahnpasta im Angebot bei Coop?', expectedTool: 'search_promotions' },
  { prompt: 'Welche Ketten unterstützen die Filial-Verfügbarkeitsprüfung?', expectedTool: 'get_store_availability_support' },
];

describe.skipIf(process.env.RUN_AGENT_EVAL !== '1')('chat agent golden-eval (real model, stubbed tool backend)', () => {
  it.each(FIXTURES)('"$prompt" -> $expectedTool', async ({ prompt, expectedTool, expectedInputContains }) => {
    const result = await runChatAgent({
      messages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: prompt }] }],
      dependencies: dependencies(),
      // A batch run waits in line; it is not a shopper watching a bubble. Without
      // this, cases queued behind a rate-limit window fail instantly and the run
      // reports rate limiting as if it were bad tool selection.
      maxQueueWaitMs: 100_000,
    });

    const steps = await result.steps;

    // A bare "expected 0 to be greater than 0" cannot distinguish "called the
    // wrong tool", "called the right tool one step late" (reasoning models
    // often spend step 1 thinking) and "called nothing at all" — and those
    // lead to three different decisions. Say which it was.
    const trace = steps
      .map((step, index) => {
        const names = step.toolCalls.map((call) => call.toolName);
        return `step ${index + 1}: ${names.length > 0 ? names.join(', ') : '(no tool call)'}`;
      })
      .join(' | ');

    const allToolCalls = steps.flatMap((step) => step.toolCalls);

    if (expectedTool === null) {
      // "Answer without tools" must hold for the whole turn, not just its start.
      expect(allToolCalls, `expected no tool call at all — ${trace}`).toHaveLength(0);
      return;
    }

    // Asserted across the turn, not on step 1 alone. Step 1 was the original
    // criterion and it was wrong: our own system prompt tells the model to call
    // set_chat_location *before* a location-dependent tool, so a model that
    // obeyed ("step 1: set_chat_location | step 2: find_stores") was scored as
    // a failure. Scores from before 2026-08-05 are not comparable to later
    // ones. What this still catches is the regression it was built for — the
    // model quietly answering from general knowledge with no tool at all.
    expect(allToolCalls.length, `expected ${expectedTool} somewhere in the turn — ${trace}`).toBeGreaterThan(
      0
    );
    expect(
      allToolCalls.some((call) => call.toolName === expectedTool),
      `expected ${expectedTool} somewhere in the turn — ${trace}`
    ).toBe(true);

    if (expectedInputContains) {
      const matchingCall = allToolCalls.find((call) => call.toolName === expectedTool);
      const inputJson = JSON.stringify(matchingCall?.input ?? {}).toLowerCase();
      expect(inputJson).toContain(expectedInputContains.toLowerCase());
    }
    // 30s was not enough once requests are paced. The free tier allows 20
    // model requests a minute across the whole account, and these ten cases
    // are one or two requests each, so the limiter (openRouterRateLimit.ts)
    // will legitimately hold a case for most of a minute rather than fire it
    // into a 429. A red run here should mean "the model picked the wrong
    // tool", never "we out-ran a published rate limit".
  }, 120_000);
});
