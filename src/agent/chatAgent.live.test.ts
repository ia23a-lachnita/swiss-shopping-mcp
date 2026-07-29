// Integration/live layer (see docs/active/CHAT_AGENT_ARCHITECTURE_PLAN.md
// "Testing"): one real end-to-end tool-calling turn against the actual
// OpenRouter API + real primary model + real chain adapters, confirming
// credentials, schema translation, and real network latency all work
// together. Matches this repo's existing `.live.test.ts` / LIVE_SOURCE_TESTS
// convention — gated the same way as every other live-vendor path.
import { describe, expect, it } from 'vitest';

import { createDefaultAdapters } from '../adapters/index.js';
import { PriceComparisonService } from '../services/priceComparisonService.js';
import { SearchService } from '../services/searchService.js';
import { runChatAgent } from './chatAgent.js';

describe.skipIf(process.env.LIVE_SOURCE_TESTS !== '1')('chatAgent live smoke', () => {
  it(
    'drives one real tool-calling turn against OpenRouter and a real chain adapter',
    async () => {
      const adapters = createDefaultAdapters();
      const dependencies = {
        searchService: new SearchService(adapters),
        priceComparisonService: new PriceComparisonService(adapters),
      };

      const result = await runChatAgent({
        messages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'Suche nach Milch bei Migros.' }] }],
        dependencies,
      });

      const steps = await result.steps;
      const text = await result.text;

      const calledSearchProducts = steps.some((step) =>
        step.toolCalls.some((call) => call.toolName === 'search_products')
      );

      expect(calledSearchProducts).toBe(true);
      expect(text.length).toBeGreaterThan(0);
    },
    30_000
  );
});
