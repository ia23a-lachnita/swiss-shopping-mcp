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
    });

    const steps = await result.steps;
    const firstStepToolCalls = steps[0]?.toolCalls ?? [];

    if (expectedTool === null) {
      expect(firstStepToolCalls).toHaveLength(0);
      return;
    }

    expect(firstStepToolCalls.length).toBeGreaterThan(0);
    expect(firstStepToolCalls.some((call) => call.toolName === expectedTool)).toBe(true);

    if (expectedInputContains) {
      const matchingCall = firstStepToolCalls.find((call) => call.toolName === expectedTool);
      const inputJson = JSON.stringify(matchingCall?.input ?? {}).toLowerCase();
      expect(inputJson).toContain(expectedInputContains.toLowerCase());
    }
  }, 30_000);
});
