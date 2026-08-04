import { simulateReadableStream, type LanguageModelV3StreamPart } from 'ai/test';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';

import { Chain, ChainAdapter, NormalizedProduct, ProductSearchFilters, Result } from '../adapters/types.js';
import { PriceComparisonService } from '../services/priceComparisonService.js';
import { SearchService } from '../services/searchService.js';
import { ToolDependencies } from '../tools/handlers.js';
import { runChatAgent } from './chatAgent.js';

function stubAdapter(chain: Chain, products: NormalizedProduct[]): ChainAdapter {
  return {
    chain,
    async searchProducts(filters: ProductSearchFilters): Promise<Result<NormalizedProduct[]>> {
      return { ok: true, data: products.slice(0, filters.limit) };
    },
    async searchPromotions() {
      return { ok: true, data: [] };
    },
    async findStores() {
      return { ok: true, data: [] };
    },
    getStoreAvailabilitySupport() {
      return { chain, supported: false };
    },
    async lookupStoreProductAvailability(filters) {
      return {
        ok: true,
        data: { chain, storeId: filters.storeId, query: filters.query, supported: false, matches: [], isAvailable: false },
      };
    },
  };
}

function dependenciesFor(adapters: ChainAdapter[]): ToolDependencies {
  return {
    searchService: new SearchService(adapters),
    priceComparisonService: new PriceComparisonService(adapters),
  };
}

// v3 finish reasons are objects ({ unified, raw }), not bare strings — the
// salvage middleware rewrites `unified` in place, so the mock has to carry the
// real shape for that path to be exercised honestly.
const STOP_FINISH = { unified: 'stop', raw: 'stop' } as const;
const TOOL_CALLS_FINISH = { unified: 'tool-calls', raw: 'tool_calls' } as const;

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function toolCallStep(toolName: string, input: Record<string, unknown>): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: 'call-1', toolName },
    { type: 'tool-input-delta', id: 'call-1', delta: JSON.stringify(input) },
    { type: 'tool-input-end', id: 'call-1' },
    { type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: TOOL_CALLS_FINISH, usage: USAGE },
  ];
}

/**
 * MockLanguageModelV3's array-based `doStream` indexes by `doStreamCalls.length`
 * AFTER pushing the call, so the first real invocation reads array index 1, not
 * 0 (confirmed against the installed ai@6.0.237 source). Pad index 0 with a
 * duplicate of the first real step so `steps` reads naturally as [step1, step2, ...].
 */
function mockDoStream(...steps: LanguageModelV3StreamPart[][]): Array<{ stream: ReadableStream<LanguageModelV3StreamPart> }> {
  const padded = [steps[0], ...steps];
  return padded.map((chunks) => ({ stream: simulateReadableStream({ chunks }) }));
}

function textStep(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
    { type: 'finish', finishReason: STOP_FINISH, usage: USAGE },
  ];
}

/** A step whose text is streamed in several deltas, so tag openers split across chunks. */
function chunkedTextStep(...deltas: string[]): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    ...deltas.map((delta) => ({ type: 'text-delta' as const, id: 'text-1', delta })),
    { type: 'text-end', id: 'text-1' },
    { type: 'finish', finishReason: STOP_FINISH, usage: USAGE },
  ];
}

describe('runChatAgent', () => {
  it('drives a real tool call end-to-end against a mocked model and reports a grounded text answer', async () => {
    const product: NormalizedProduct = { id: 'p1', chain: 'migros', name: 'Vollmilch 1L', price: { current: 1.5 } };
    const adapter = stubAdapter('migros', [product]);
    const searchProductsSpy = vi.spyOn(adapter, 'searchProducts');
    const dependencies = dependenciesFor([adapter]);

    const mockModel = new MockLanguageModelV3({
      doStream: mockDoStream(
        toolCallStep('search_products', { query: 'milch' }),
        textStep('Ich habe Vollmilch 1L bei Migros für CHF 1.50 gefunden.')
      ),
    });

    const result = await runChatAgent({
      messages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'search for milch' }] }],
      dependencies,
      model: mockModel,
    });

    const text = await result.text;
    const steps = await result.steps;

    // The adapter behind search_products was actually invoked — proves the
    // model's tool call was dispatched through the real tool layer, not stubbed out.
    expect(searchProductsSpy).toHaveBeenCalledWith(expect.objectContaining({ query: 'milch' }));
    expect(steps).toHaveLength(2);
    expect(text).toContain('Vollmilch');
  });

  it('propagates a tool error as a visible grounded result rather than crashing the turn', async () => {
    const dependencies = dependenciesFor([]); // no adapters -> unsupported/empty results, never a thrown exception

    const mockModel = new MockLanguageModelV3({
      doStream: mockDoStream(
        toolCallStep('search_products', { query: 'milch' }),
        textStep('Ich konnte nichts finden.')
      ),
    });

    const result = await runChatAgent({
      messages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'search for milch' }] }],
      dependencies,
      model: mockModel,
    });

    const text = await result.text;
    expect(text).toContain('nichts finden');
  });

  // Reported from a real phone on 2026-08-04: the model wrote its tool call as
  // message text, so nothing executed and the tags rendered as the answer.
  it('executes a tool call the model wrote as text instead of as a real call', async () => {
    const adapter = stubAdapter('coop', []);
    const availabilitySpy = vi.spyOn(adapter, 'lookupStoreProductAvailability');
    const dependencies = dependenciesFor([adapter]);

    const mockModel = new MockLanguageModelV3({
      doStream: mockDoStream(
        // Split exactly where a tag opener straddles two chunks — a naive
        // per-delta scan would miss this one.
        chunkedTextStep(
          'Einen Moment. <tool',
          '_call>\n<function=lookup_store_product_availability_storeId>\n',
          '5537? Actually we need to pass: { chain: "coop", storeId: "5532", query: "almond milk"}'
        ),
        textStep('Almond Milk ist in dieser Filiale nicht gelistet.')
      ),
    });

    const result = await runChatAgent({
      messages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'gibt es almond milk?' }] }],
      dependencies,
      model: mockModel,
    });

    const text = await result.text;
    const steps = await result.steps;

    expect(availabilitySpy).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: '5532', query: 'almond milk' })
    );
    // `result.text` is the last step only, so the leaked step is checked directly.
    expect(steps[0].text).toBe('Einen Moment. '); // prose before the tag survives; the tag does not
    expect(text).not.toContain('tool_call');
    expect(text).toContain('nicht gelistet');
  });

  it('lets an unsalvageable tool-call leak through as text rather than dropping the turn', async () => {
    const dependencies = dependenciesFor([]);
    const mockModel = new MockLanguageModelV3({
      // No recoverable tool name — the client turns this into a visible failed turn.
      doStream: mockDoStream(chunkedTextStep('<tool_call>{"query": "milch"}</tool_call>')),
    });

    const result = await runChatAgent({
      messages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'milch' }] }],
      dependencies,
      model: mockModel,
    });

    expect(await result.text).toContain('<tool_call>');
  });

  it('folds activeLocation into the system prompt for that turn when provided', async () => {
    const dependencies = dependenciesFor([]);
    const mockModel = new MockLanguageModelV3({
      doStream: mockDoStream(textStep('Alles klar.')),
    });

    const result = await runChatAgent({
      messages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'hallo' }] }],
      dependencies,
      activeLocation: 'Zürich',
      model: mockModel,
    });
    await result.text;

    const systemMessage = mockModel.doStreamCalls[0].prompt.find((m) => m.role === 'system');
    expect(systemMessage?.content).toContain('current chat location is "Zürich"');
  });

  it('omits location context from the system prompt when no activeLocation is set', async () => {
    const dependencies = dependenciesFor([]);
    const mockModel = new MockLanguageModelV3({
      doStream: mockDoStream(textStep('Alles klar.')),
    });

    const result = await runChatAgent({
      messages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'hallo' }] }],
      dependencies,
      model: mockModel,
    });
    await result.text;

    const systemMessage = mockModel.doStreamCalls[0].prompt.find((m) => m.role === 'system');
    expect(systemMessage?.content).not.toContain('current chat location is');
  });
});
