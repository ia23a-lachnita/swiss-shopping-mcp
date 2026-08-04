import { describe, expect, it } from 'vitest';

import {
  extractFirstObject,
  findTriggerIndex,
  looksLikeToolCallSyntax,
  partialTriggerTailLength,
  resolveToolName,
  salvageToolCallFromText,
} from './textToolCall.js';

/**
 * Verbatim from the screenshot the owner sent on 2026-08-04 — the whole point
 * of this module is that this exact text becomes a real tool call. Note the
 * glued-on parameter name, the model arguing with itself, and the bare object
 * keys that make it invalid JSON.
 */
const FIELD_SAMPLE = `<tool_call>
<function=lookup_store_product_availability_storeId>
5537? Actually we need to pass: { chain: "coop", storeId: "5532", query: "almond milk"}`;

describe('salvageToolCallFromText', () => {
  it('recovers the reported field failure, mangled tool name and all', () => {
    const salvaged = salvageToolCallFromText(FIELD_SAMPLE);

    expect(salvaged).toEqual({
      toolName: 'lookup_store_product_availability',
      input: JSON.stringify({ chain: 'coop', storeId: '5532', query: 'almond milk' }),
    });
  });

  it('recovers the Hermes wrapper form and unwraps its arguments', () => {
    const salvaged = salvageToolCallFromText(
      '<tool_call>{"name": "search_products", "arguments": {"query": "milch", "chains": ["migros"]}}</tool_call>'
    );

    expect(salvaged?.toolName).toBe('search_products');
    expect(JSON.parse(salvaged?.input ?? '{}')).toEqual({ query: 'milch', chains: ['migros'] });
  });

  it('recovers a stringified arguments payload', () => {
    const salvaged = salvageToolCallFromText(
      '<function_call>{"name": "find_stores", "arguments": "{\\"chain\\": \\"coop\\"}"}'
    );

    expect(salvaged?.toolName).toBe('find_stores');
    expect(JSON.parse(salvaged?.input ?? '{}')).toEqual({ chain: 'coop' });
  });

  it('leaves ordinary prose alone', () => {
    expect(salvageToolCallFromText('Bei Migros kostet die Vollmilch CHF 1.50.')).toBeUndefined();
    expect(looksLikeToolCallSyntax('Bei Migros kostet die Vollmilch CHF 1.50.')).toBe(false);
  });

  it('refuses to guess when the arguments object was never closed', () => {
    expect(salvageToolCallFromText('<tool_call><function=search_products>{"query": "mil')).toBeUndefined();
  });

  it('refuses to guess when no tool name is recoverable', () => {
    expect(salvageToolCallFromText('<tool_call>{"query": "milch"}</tool_call>')).toBeUndefined();
    expect(salvageToolCallFromText('<function=teleport_me>{"x": 1}')).toBeUndefined();
  });
});

describe('resolveToolName', () => {
  it('prefers the longest match so tools sharing a stem stay distinguishable', () => {
    expect(resolveToolName('lookup_store_product_availability_storeId')).toBe(
      'lookup_store_product_availability'
    );
    expect(resolveToolName('lookup_availability_by_location')).toBe('lookup_availability_by_location');
  });

  it('strips namespace prefixes models add', () => {
    expect(resolveToolName('functions.compare_prices')).toBe('compare_prices');
    expect(resolveToolName('tools:search_products')).toBe('search_products');
  });

  it('returns undefined for a name that matches no tool', () => {
    expect(resolveToolName('order_pizza')).toBeUndefined();
  });
});

describe('streaming helpers', () => {
  it('withholds a tail that could still grow into a tag opener', () => {
    // "…gefunden. <tool" must not reach the user: the next chunk may close it.
    expect(partialTriggerTailLength('Ich habe etwas gefunden. <tool')).toBe(5);
    expect(partialTriggerTailLength('Ich habe etwas gefunden.')).toBe(0);
    expect(partialTriggerTailLength('Preis <')).toBe(1);
  });

  it('reports where the tag starts so prose before it can still stream', () => {
    expect(findTriggerIndex('Einen Moment. <tool_call>')).toBe(14);
    expect(findTriggerIndex('Einen Moment.')).toBe(-1);
  });
});

describe('extractFirstObject', () => {
  it('is string-aware, so a brace inside a value does not end the object', () => {
    expect(extractFirstObject('call: {"query": "brot {bio}", "limit": 3} trailing')).toBe(
      '{"query": "brot {bio}", "limit": 3}'
    );
  });

  it('keeps nested objects intact', () => {
    expect(extractFirstObject('{"a": {"b": 1}}')).toBe('{"a": {"b": 1}}');
  });
});
