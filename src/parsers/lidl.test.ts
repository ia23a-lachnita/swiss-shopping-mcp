import { describe, expect, it } from 'vitest';

import { parseLidlLeafletProducts, parseLidlSearchPage, parseLidlStoresResponse } from './lidl.js';

describe('Lidl parser', () => {
  it('parses leaflet products from HTML', () => {
    const html = `<div class="product"><span class="product-title">Lidl Vollmilch</span><span>1.49</span></div>`;
    const result = parseLidlLeafletProducts(html, 'https://www.lidl.ch/de/angebote');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'Lidl Vollmilch',
      price: { current: 1.49, currency: 'CHF' },
    });
  });

  it('skips cards without valid price', () => {
    const html = `<div class="product"><span class="product-title">No Price</span></div>`;
    const result = parseLidlLeafletProducts(html, 'https://example.com');
    expect(result).toHaveLength(0);
  });

  it('parses search page products from HTML', () => {
    const impressionData = {
      id: '10054750',
      name: 'Vollkornbrot',
      price: 2.99,
      category: 'Food',
      categoryPrimary: 'Food',
    };
    const html = `
      <html>
      <body>
        <div data-gridbox-impression="${encodeURIComponent(JSON.stringify(impressionData))}" data-qa-label="product-grid-box-link-10054750">
          <a href="/p/de-CH/vollkornbrot/p10054750">
            <img src="https://example.com/image.jpg" />
          </a>
          <div class="brand">Test Brand</div>
        </div>
      </body>
      </html>
    `;
    const result = parseLidlSearchPage(html, 'https://www.lidl.ch/q/de-CH/search?q=brot');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: '10054750',
      name: 'Vollkornbrot',
      price: { current: 2.99, currency: 'CHF' },
      category: 'Food',
      brand: 'Test Brand',
      image: 'https://example.com/image.jpg',
    });
  });

  it('parses multiple search page products', () => {
    const impression1 = { id: '100', name: 'Product 1', price: 1.99, category: 'Food' };
    const impression2 = { id: '200', name: 'Product 2', price: 3.49, category: 'Food' };
    const html = `
      <html>
      <body>
        <div data-gridbox-impression="${encodeURIComponent(JSON.stringify(impression1))}">
          <a href="/p/de-CH/product-1/p100"><img src="https://example.com/1.jpg" /></a>
          <div class="brand">Brand A</div>
        </div>
        <div data-gridbox-impression="${encodeURIComponent(JSON.stringify(impression2))}">
          <a href="/p/de-CH/product-2/p200"><img src="https://example.com/2.jpg" /></a>
          <div class="brand">Brand B</div>
        </div>
      </body>
      </html>
    `;
    const result = parseLidlSearchPage(html, 'https://www.lidl.ch/q/de-CH/search?q=product');

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('100');
    expect(result[1].id).toBe('200');
  });

  it('skips search page products without valid data', () => {
    const html = `
      <html>
      <body>
        <div data-gridbox-impression="${encodeURIComponent(JSON.stringify({ id: '', name: '', price: 0 }))}">
        </div>
        <div data-gridbox-impression="${encodeURIComponent(JSON.stringify({ id: '100', name: 'Valid', price: 1.99 }))}">
        </div>
      </body>
      </html>
    `;
    const result = parseLidlSearchPage(html, 'https://www.lidl.ch/q/de-CH/search?q=test');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('100');
  });

  it('parses store finder HTML', () => {
    const html = `<div class="store" data-lat="47.37" data-lng="8.54"><div class="store-name">Lidl Zürich</div><div class="store-address">Bahnhofstr. 1</div></div>`;
    const result = parseLidlStoresResponse(html, 'https://www.lidl.ch/de/filialfinder');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'Lidl Zürich',
      latitude: 47.37,
      longitude: 8.54,
    });
  });

  it('skips stores without coordinates', () => {
    const html = `<div class="store"><div class="store-name">Store</div></div>`;
    const result = parseLidlStoresResponse(html, 'https://example.com');
    expect(result).toHaveLength(0);
  });
});
