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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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

        await sleep(100 * (attempt + 1));
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
    await this.waitForHostSlot(url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers(init?.headers);
    headers.set('user-agent', this.userAgent);
    headers.set('accept', acceptHeader);

    try {
      const response = await this.fetchImpl(url, {
        ...init,
        headers,
        signal: controller.signal,
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

      const message = error instanceof Error ? error.message : String(error);
      throw new SourceClientError(SourceWarningCode.SourceUnavailable, message, url);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async waitForHostSlot(url: string): Promise<void> {
    if (this.rateLimitPerHostMs <= 0) {
      return;
    }

    const host = new URL(url).host;
    const now = Date.now();
    const lastRequestAt = this.lastRequestByHost.get(host);
    if (lastRequestAt !== undefined) {
      const waitMs = this.rateLimitPerHostMs - (now - lastRequestAt);
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }

    this.lastRequestByHost.set(host, Date.now());
  }
}
