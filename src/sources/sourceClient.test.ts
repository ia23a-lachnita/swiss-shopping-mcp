import { afterEach, describe, expect, it, vi } from 'vitest';

import { SourceClientError, SourceHttpClient } from './sourceClient.js';
import { SourceWarningCode } from '../adapters/types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Failure',
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    statusText: status === 200 ? 'OK' : 'Failure',
    headers: { 'content-type': 'text/html' },
  });
}

describe('SourceHttpClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns JSON data with live provenance and request headers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ products: [] })) as unknown as typeof fetch;
    const client = new SourceHttpClient({
      fetchImpl,
      retries: 0,
      rateLimitPerHostMs: 0,
      userAgent: 'test-agent',
    });

    const result = await client.fetchJson<{ products: unknown[] }>('https://example.test/search', {
      provider: 'Example',
      chain: 'migros',
      sourceType: 'retailer-web',
      confidence: 'high',
    });

    expect(result.data.products).toEqual([]);
    expect(result.provenance).toMatchObject({
      provider: 'Example',
      chain: 'migros',
      sourceType: 'retailer-web',
      sourceUrl: 'https://example.test/search',
      freshness: 'live',
      confidence: 'high',
    });

    const init = vi.mocked(fetchImpl).mock.calls[0][1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get('user-agent')).toBe('test-agent');
    expect(headers.get('accept')).toBe('application/json');
  });

  it('returns text data with live provenance and web document request headers', async () => {
    const fetchImpl = vi.fn(async () => textResponse('<html></html>')) as unknown as typeof fetch;
    const client = new SourceHttpClient({
      fetchImpl,
      retries: 0,
      rateLimitPerHostMs: 0,
      userAgent: 'test-agent',
    });

    const result = await client.fetchText('https://example.test/product', {
      provider: 'Example',
      chain: 'aldi',
      sourceType: 'retailer-web',
      confidence: 'medium',
    });

    expect(result.data).toBe('<html></html>');
    expect(result.provenance).toMatchObject({
      provider: 'Example',
      chain: 'aldi',
      sourceType: 'retailer-web',
      sourceUrl: 'https://example.test/product',
      freshness: 'live',
      confidence: 'medium',
    });

    const init = vi.mocked(fetchImpl).mock.calls[0][1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get('user-agent')).toBe('test-agent');
    expect(headers.get('accept')).toContain('text/html');
    expect(headers.get('accept')).toContain('application/xml');
  });

  it('retries unavailable responses before succeeding', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: true }, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true })) as unknown as typeof fetch;
    const client = new SourceHttpClient({ fetchImpl, retries: 1, rateLimitPerHostMs: 0 });

    const result = await client.fetchJson<{ ok: boolean }>('https://example.test/search', {
      provider: 'Example',
      sourceType: 'retailer-web',
    });

    expect(result.data.ok).toBe(true);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
  });

  it('maps HTTP 429 to a source rate-limit error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: true }, 429)) as unknown as typeof fetch;
    const client = new SourceHttpClient({ fetchImpl, retries: 0, rateLimitPerHostMs: 0 });

    await expect(
      client.fetchJson('https://example.test/search', {
        provider: 'Example',
        sourceType: 'retailer-web',
      }),
    ).rejects.toMatchObject({
      code: SourceWarningCode.SourceRateLimited,
      status: 429,
    } satisfies Partial<SourceClientError>);
  });

  it('maps invalid JSON to a parse failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('not-json', { status: 200 })) as unknown as typeof fetch;
    const client = new SourceHttpClient({ fetchImpl, retries: 0, rateLimitPerHostMs: 0 });

    await expect(
      client.fetchJson('https://example.test/search', {
        provider: 'Example',
        sourceType: 'retailer-web',
      }),
    ).rejects.toMatchObject({
      code: SourceWarningCode.SourceParseFailed,
    } satisfies Partial<SourceClientError>);
  });

  it('maps request timeout aborts to source unavailable errors', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    ) as unknown as typeof fetch;
    const client = new SourceHttpClient({
      fetchImpl,
      retries: 0,
      rateLimitPerHostMs: 0,
      timeoutMs: 10,
    });

    const request = client.fetchJson('https://example.test/slow', {
      provider: 'Example',
      sourceType: 'retailer-web',
    });
    const expectation = expect(request).rejects.toMatchObject({
      code: SourceWarningCode.SourceUnavailable,
    } satisfies Partial<SourceClientError>);

    await vi.advanceTimersByTimeAsync(10);
    await expectation;
  });

  it('enforces per-host request spacing', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    const client = new SourceHttpClient({
      fetchImpl,
      retries: 0,
      rateLimitPerHostMs: 100,
    });

    await client.fetchJson('https://example.test/one', {
      provider: 'Example',
      sourceType: 'retailer-web',
    });

    const secondRequest = client.fetchJson('https://example.test/two', {
      provider: 'Example',
      sourceType: 'retailer-web',
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await secondRequest;
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
  });
});
