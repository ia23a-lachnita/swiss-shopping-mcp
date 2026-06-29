/**
 * Lidl.ch Playwright browser session manager.
 *
 * Lidl.ch uses client-side rendering for search results — server-side
 * fetch returns empty HTML. This module launches a headless Chromium
 * via Playwright, navigates to the search page, waits for the product
 * grid to render, and extracts product data from the live DOM.
 */

import type { Browser, BrowserContext, Page } from 'playwright-core';

const CHROMIUM_PATH = 'C:\\Users\\xursc\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';
const LIDL_ORIGIN = 'https://www.lidl.ch';
const DEFAULT_TIMEOUT_MS = 30_000;

let browserInstance: Browser | null = null;
let contextInstance: BrowserContext | null = null;
let lidlPage: Page | null = null;
let initializationPromise: Promise<void> | null = null;

async function ensureBrowser(): Promise<Page> {
  if (lidlPage && !lidlPage.isClosed()) return lidlPage;

  if (initializationPromise) {
    await initializationPromise;
    if (lidlPage && !lidlPage.isClosed()) return lidlPage;
  }

  initializationPromise = (async () => {
    const { chromium } = await import('playwright-core');
    browserInstance = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    contextInstance = await browserInstance.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      locale: 'de-CH',
    });
    lidlPage = await contextInstance.newPage();
    await lidlPage.goto(LIDL_ORIGIN, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
    // Wait for page to be interactive
    await lidlPage.waitForTimeout(2000);
  })();

  await initializationPromise;
  if (!lidlPage) throw new Error('Failed to initialize Lidl browser');
  return lidlPage;
}

export interface LidlBrowserProduct {
  id: string;
  name: string;
  category?: string;
  price?: number;
  image?: string;
  url?: string;
}

/**
 * Search Lidl.ch products by navigating to the search page in a headless
 * browser, waiting for client-side rendering, and extracting product data
 * from the rendered DOM.
 */
export async function searchProducts(query: string): Promise<LidlBrowserProduct[]> {
  const page = await ensureBrowser();
  const searchUrl = `${LIDL_ORIGIN}/q/de-CH/search?q=${encodeURIComponent(query)}`;

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });

  // Wait for product grid to render (data-gridbox-impression elements)
  try {
    await page.waitForSelector('[data-gridbox-impression]', { timeout: 10_000 });
  } catch {
    // No products found or page didn't render — return empty
    return [];
  }

  // Extract product data from rendered DOM
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const products = await page.evaluate((_: any) => {
    // This code runs in the browser context where document is available
    const gridboxes = (globalThis as any).document.querySelectorAll('[data-gridbox-impression]');
    const results: Array<{ id: string; name: string; category?: string; price?: number; image?: string; url?: string }> = [];

    gridboxes.forEach((gb: any) => {
      try {
        const rawData = gb.getAttribute('data-gridbox-impression');
        if (!rawData) return;
        const data = JSON.parse(decodeURIComponent(rawData));
        const nameEl = gb.querySelector('.product-box__name, [class*="name"]');
        const imgEl = gb.querySelector('img');
        const linkEl = gb.querySelector('a');

        results.push({
          id: String(data.id || ''),
          name: data.name || nameEl?.textContent?.trim() || '',
          category: data.category,
          price: typeof data.price === 'number' ? data.price : undefined,
          image: imgEl?.getAttribute('src') || undefined,
          url: (() => {
            const href = linkEl?.getAttribute('href') || '';
            if (!href) return undefined;
            if (href.startsWith('http')) return href;
            return (globalThis as any).location.origin + (href.startsWith('/') ? href : '/' + href);
          })(),
        });
      } catch {
        // Skip malformed entries
      }
    });

    return results;
  }, undefined);

  return products;
}

export async function closeBrowser(): Promise<void> {
  if (lidlPage && !lidlPage.isClosed()) {
    await lidlPage.close().catch(() => {});
    lidlPage = null;
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
