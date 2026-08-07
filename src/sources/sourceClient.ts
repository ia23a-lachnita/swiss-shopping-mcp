import { abortableSleep, isAbortError, throwIfAborted } from '../util/cancellation.js';
import {
  Chain,
  SourceConfidence,
  SourceProvenance,
  SourceType,
  SourceWarningCode,
} from '../adapters/types.js';

const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
const PRIVATE_IP_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^fc00:/i,
  /^fe80:/i,
];

function validateUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SourceClientError(
      SourceWarningCode.SourceTermsBlocked,
      `Blocked URL with non-http(s) protocol: ${parsed.protocol}`,
      url
    );
  }
  const hostname = parsed.hostname;
  if (BLOCKED_HOSTS.has(hostname)) {
    throw new SourceClientError(
      SourceWarningCode.SourceTermsBlocked,
      `Blocked request to private host: ${hostname}`,
      url
    );
  }
  if (PRIVATE_IP_RANGES.some((range) => range.test(hostname))) {
    throw new SourceClientError(
      SourceWarningCode.SourceTermsBlocked,
      `Blocked request to private IP: ${hostname}`,
      url
    );
  }
}

export interface SourceFetchOptions {
  provider: string;
  sourceType: SourceType;
  chain?: Chain;
  confidence?: SourceConfidence;
  init?: RequestInit;
}

export interface SourceFetchResult<T> {
  data: T;
  provenance: SourceProvenance;
}

export interface SourceHttpClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  userAgent?: string;
  rateLimitPerHostMs?: number;
}

export class SourceClientError extends Error {
  public readonly code: SourceWarningCode;
  public readonly status?: number;
  public readonly sourceUrl: string;

  public constructor(code: SourceWarningCode, message: string, sourceUrl: string, status?: number) {
    super(message);
    this.name = 'SourceClientError';
    this.code = code;
    this.status = status;
    this.sourceUrl = sourceUrl;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = 'swiss-shopping-mcp/0.1 (+https://github.com/local/swiss-shopping-mcp)';

function shouldRetry(error: SourceClientError): boolean {
  return error.code === SourceWarningCode.SourceUnavailable || error.code === SourceWarningCode.SourceRateLimited;
}

export class SourceHttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly userAgent: string;
  private readonly rateLimitPerHostMs: number;
  private readonly lastRequestByHost = new Map<string, number>();

  public constructor(options: SourceHttpClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? 1;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.rateLimitPerHostMs = options.rateLimitPerHostMs ?? 250;
  }

  public async fetchJson<T>(url: string, options: SourceFetchOptions): Promise<SourceFetchResult<T>> {
    validateUrl(url);
    return this.fetchWithProvenance(url, options, async () => this.fetchJsonOnce<T>(url, options.init));
  }

  public async fetchText(url: string, options: SourceFetchOptions): Promise<SourceFetchResult<string>> {
    validateUrl(url);
    return this.fetchWithProvenance(url, options, async () =>
      this.fetchTextOnce(url, options.init, 'text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8'),
    );
  }

  private async fetchWithProvenance<T>(
    url: string,
    options: SourceFetchOptions,
    fetcher: () => Promise<T>,
  ): Promise<SourceFetchResult<T>> {
    let lastError: SourceClientError | undefined;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const data = await fetcher();
        const observedAt = new Date().toISOString();
        return {
          data,
          provenance: {
            provider: options.provider,
            chain: options.chain,
            sourceType: options.sourceType,
            sourceUrl: url,
            observedAt,
            freshness: 'live',
            confidence: options.confidence ?? 'medium',
          },
        };
      } catch (error) {
        if (!(error instanceof SourceClientError)) {
          throw error;
        }

        lastError = error;
        if (attempt >= this.retries || !shouldRetry(error)) {
          break;
        }

        // Checked before the backoff, not after it: a cancelled request that
        // hit a retryable 429 would otherwise sleep out its backoff and fire a
        // second request that nobody is waiting for.
        throwIfAborted(options.init?.signal ?? undefined, url);
        await abortableSleep(100 * (attempt + 1), options.init?.signal ?? undefined, url);
      }
    }

    throw lastError ?? new SourceClientError(SourceWarningCode.SourceUnavailable, 'Source request failed.', url);
  }

  private async fetchJsonOnce<T>(url: string, init?: RequestInit): Promise<T> {
    const text = await this.fetchTextOnce(url, init, 'application/json');

    try {
      return JSON.parse(text) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SourceClientError(SourceWarningCode.SourceParseFailed, message, url);
    }
  }

  private async fetchTextOnce(url: string, init: RequestInit | undefined, acceptHeader: string): Promise<string> {
    // Abort *before* queueing, not just before dispatch: a request that has
    // already been cancelled must not sit out its rate-limit turn only to be
    // thrown away on the far side.
    throwIfAborted(init?.signal ?? undefined, url);
    await this.waitForHostSlot(url, init?.signal ?? undefined);

    // The caller's signal is combined with this client's own deadline rather
    // than replacing it. Spreading `init` after the signal (as this did) let a
    // caller's signal through by accident; spreading it before dropped the
    // caller's entirely, which is why cancellation never reached the wire.
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    const headers = new Headers(init?.headers);
    headers.set('user-agent', this.userAgent);
    headers.set('accept', acceptHeader);

    try {
      const response = await this.fetchImpl(url, {
        ...init,
        headers,
        signal,
      });

      if (!response.ok) {
        const code =
          response.status === 429 ? SourceWarningCode.SourceRateLimited : SourceWarningCode.SourceUnavailable;
        throw new SourceClientError(code, `HTTP ${response.status}: ${response.statusText}`, url, response.status);
      }

      try {
        return await response.text();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new SourceClientError(SourceWarningCode.SourceParseFailed, message, url);
      }
    } catch (error) {
      if (error instanceof SourceClientError) {
        throw error;
      }

      // Whose abort was it? Both arrive here as the same DOMException, and the
      // difference decides whether a chain gets blamed.
      //
      //   caller's signal  -> a cancellation: propagate untouched, so it never
      //                       reaches the retry set or the circuit breaker. A
      //                       shopper closing a tab must not mark a chain dead.
      //   this client's own timeout -> the vendor did not answer in time, which
      //                       is exactly what SOURCE_UNAVAILABLE means and has
      //                       always meant. Unchanged behaviour.
      if (isAbortError(error) && init?.signal?.aborted) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new SourceClientError(SourceWarningCode.SourceUnavailable, message, url);
    }
  }

  private async waitForHostSlot(url: string, signal: AbortSignal | undefined): Promise<void> {
    if (this.rateLimitPerHostMs <= 0) {
      return;
    }

    const host = new URL(url).host;
    const now = Date.now();
    const lastRequestAt = this.lastRequestByHost.get(host);
    if (lastRequestAt !== undefined) {
      const waitMs = this.rateLimitPerHostMs - (now - lastRequestAt);
      if (waitMs > 0) {
        await abortableSleep(waitMs, signal, url);
      }
    }

    // Only stamped once we are actually going to dispatch. An abort during the
    // wait above throws past this line, which is correct: nothing was sent, so
    // nothing consumed the slot and the next caller inherits the original
    // schedule. No resource is held across the wait, so there is nothing to
    // release on the abort path.
    this.lastRequestByHost.set(host, Date.now());
  }
}
