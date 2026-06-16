import { describe, expect, it } from 'vitest';

import { parseLidlLeafletProducts, parseLidlStoresResponse } from './lidl.js';

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
