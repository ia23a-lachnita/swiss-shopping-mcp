/**
 * Migros browser session manager.
 * Uses Playwright to bypass Cloudflare bot protection.
 * Navigates to migros.ch and keeps a page open there.
 * All API calls are made via page.evaluate() from the same origin,
 * which carries the Cloudflare clearance cookies.
 */
import { Browser, BrowserContext, Page } from 'playwright-core';
import { chromium } from 'playwright-core';

const MIGROS_ORIGIN = 'https://www.migros.ch';
const GUEST_URL = `${MIGROS_ORIGIN}/authentication/public/v1/api/guest?authorizationNotRequired=true`;
const SEARCH_URL = `${MIGROS_ORIGIN}/product-display/public/v2/products/search`;
const PRODUCT_CARDS_URL = `${MIGROS_ORIGIN}/product-display/public/v4/product-cards`;
const STORES_URL = `${MIGROS_ORIGIN}/store/public/v1/stores/search`;
const AVAILABILITY_URL = `${MIGROS_ORIGIN}/store-availability/public/v2/availabilities/products`;
const DEFAULT_TIMEOUT_MS = 30_000;

let browserInstance: Browser | null = null;
let contextInstance: BrowserContext | null = null;
let migrosPage: Page | null = null;
let initializationPromise: Promise<void> | null = null;

async function ensureBrowser(): Promise<Page> {
  if (migrosPage && !migrosPage.isClosed()) return migrosPage;

  // Prevent multiple concurrent initializations
  if (initializationPromise) {
    await initializationPromise;
    if (migrosPage && !migrosPage.isClosed()) return migrosPage;
  }

  initializationPromise = (async () => {
    // Close existing resources
    if (migrosPage && !migrosPage.isClosed()) await migrosPage.close().catch(() => {});
    if (contextInstance) await contextInstance.close().catch(() => {});
    if (browserInstance) await browserInstance.close().catch(() => {});

    browserInstance = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    contextInstance = await browserInstance.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'de-CH',
      timezoneId: 'Europe/Zurich',
    });

    // Navigate to Migros to trigger Cloudflare clearance
    migrosPage = await contextInstance.newPage();
    await migrosPage.goto(MIGROS_ORIGIN, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
    // Wait for Cloudflare to set cookies
    await migrosPage.waitForTimeout(3000);
  })();

  try {
    await initializationPromise;
  } catch (error) {
    browserInstance = null;
    contextInstance = null;
    migrosPage = null;
    initializationPromise = null;
    throw error;
  }

  return migrosPage!;
}

/**
 * Execute a fetch-like request via page.evaluate() from the Migros origin.
 * Since the page is on migros.ch, fetch calls are same-origin and carry
 * the Cloudflare clearance cookies.
 */
export async function migrosFetch(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; data: unknown; headers: Record<string, string> }> {
  const page = await ensureBrowser();

  const method = options.method || 'GET';
  const headers = options.headers || {};
  const bodyStr = options.body ? JSON.stringify(options.body) : undefined;

  const result = await page.evaluate(
    async (args) => {
      const { fetchUrl, fetchMethod, fetchHeaders, fetchBody } = args;
      const init: RequestInit = {
        method: fetchMethod,
        headers: fetchHeaders,
      };
      if (fetchBody) init.body = fetchBody;

      const resp = await fetch(fetchUrl, init);
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => { respHeaders[k] = v; });

      let data: unknown;
      const text = await resp.text();
      try { data = JSON.parse(text); } catch { data = text; }

      return { status: resp.status, data, headers: respHeaders };
    },
    { fetchUrl: url, fetchMethod: method, fetchHeaders: headers, fetchBody: bodyStr }
  );

  return result;
}

/**
 * Get a guest token from the Migros API.
 */
export async function getGuestToken(): Promise<string> {
  const resp = await migrosFetch(GUEST_URL, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (resp.status !== 200) {
    throw new Error(`Guest token request failed with status ${resp.status}`);
  }

  const token = resp.headers['leshopch'];
  if (!token || typeof token !== 'string') {
    throw new Error('No guest token in response');
  }
  return token;
}

/**
 * Search for products via the browser context.
 */
export async function searchProducts(
  query: string,
  options: {
    language?: string;
    storeType?: string;
    region?: string;
    limit?: number;
    from?: number;
    filters?: Record<string, unknown>;
    searchAlgorithm?: string;
    token: string;
  }
): Promise<unknown> {
  const body = {
    query,
    language: options.language ?? 'de',
    storeType: options.storeType ?? 'ONLINE',
    region: options.region,
    sortFields: [],
    sortOrder: 'asc',
    from: options.from ?? 0,
    limit: options.limit ?? 20,
    filters: options.filters ?? {},
    searchAlgorithm: options.searchAlgorithm ?? 'DEFAULT',
    mtid: null,
    enabledSponsoredProducts: true,
  };

  const resp = await migrosFetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      leshopch: options.token,
    },
    body,
  });

  if (resp.status !== 200) {
    throw new Error(`Search request failed with status ${resp.status}: ${typeof resp.data === 'string' ? resp.data.substring(0, 200) : JSON.stringify(resp.data).substring(0, 200)}`);
  }
  return resp.data;
}

/**
 * Fetch product card details via the browser context.
 */
export async function fetchProductCards(
  productIds: number[],
  token: string,
  offerFilter?: {
    storeType?: string;
    region?: string;
    ongoingOfferDate?: string;
  }
): Promise<unknown> {
  const body = {
    productFilter: { uids: productIds },
    offerFilter: offerFilter ?? {
      storeType: 'OFFLINE',
      region: 'NATIONAL',
      ongoingOfferDate: new Date().toISOString().split('T')[0] + 'T00:00:00',
    },
  };

  const resp = await migrosFetch(PRODUCT_CARDS_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      leshopch: token,
    },
    body,
  });

  if (resp.status !== 200) {
    throw new Error(`Product cards request failed with status ${resp.status}`);
  }
  return resp.data;
}

/**
 * Search for stores via the browser context.
 */
export async function searchStores(
  query: string,
  token: string
): Promise<unknown> {
  const resp = await migrosFetch(`${STORES_URL}?query=${encodeURIComponent(query)}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      leshopch: token,
    },
  });

  if (resp.status !== 200) {
    throw new Error(`Store search request failed with status ${resp.status}`);
  }
  return resp.data;
}

/**
 * Check store availability via the browser context.
 */
export async function checkAvailability(
  productId: string,
  storeIds: string[],
  token: string
): Promise<unknown> {
  const storeParam = storeIds.join(',');
  const resp = await migrosFetch(
    `${AVAILABILITY_URL}/${productId}?costCenterIds=${storeParam}`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        leshopch: token,
      },
    }
  );

  if (resp.status !== 200) {
    throw new Error(`Availability request failed with status ${resp.status}`);
  }
  return resp.data;
}

/**
 * Fetch detailed product information including nutrition/ingredients via the MGB endpoint.
 * This endpoint returns productInformation which is NOT available via product-cards.
 */
export async function fetchProductDetail(
  migrosId: string,
  token: string
): Promise<unknown> {
  const page = await ensureBrowser();

  const result = await page.evaluate(
    async (args) => {
      const { fetchUrl, fetchToken } = args;
      const resp = await fetch(fetchUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          'leshopch': fetchToken,
          'x-correlation-id': 'mcp-' + Date.now(),
          'accept-language': 'de',
          'migros-language': 'de',
          'peer-id': 'website-js-1192.0.0',
        },
        body: JSON.stringify({ storeType: 'OFFLINE', warehouseId: 2, region: 'national' }),
      });

      let data: unknown;
      const text = await resp.text();
      try { data = JSON.parse(text); } catch { data = text; }

      return { status: resp.status, data };
    },
    { fetchUrl: `${MIGROS_ORIGIN}/product-display/public/v1/products/mgb/${migrosId}`, fetchToken: token }
  );

  if (result.status !== 200) {
    throw new Error(`Product detail request failed with status ${result.status}`);
  }
  return result.data;
}

export async function closeBrowser(): Promise<void> {
  if (migrosPage && !migrosPage.isClosed()) {
    await migrosPage.close().catch(() => {});
    migrosPage = null;
  }
  if (contextInstance) {
    await contextInstance.close().catch(() => {});
    contextInstance = null;
  }
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
  initializationPromise = null;
}
