import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parseDennerPromotionsPage } from './denner.js';

async function readFixture(): Promise<string> {
  return readFile(
    new URL('../../fixtures/live-sources/denner/current-actions.sample.html', import.meta.url),
    'utf8'
  );
}

describe('parseDennerPromotionsPage', () => {
  it('parses Denner promotion cards with prices, validity, units, and source URLs', async () => {
    const html = await readFixture();
    const promotions = parseDennerPromotionsPage(
      html,
      'https://www.denner.ch/de/aktionen/aktuelle-aktionen'
    );

    expect(promotions).toHaveLength(2);
    expect(promotions[0]).toMatchObject({
      id: 'denner-poulet-kalbsbratwurst~p1003622:17a93bff-db8f-43e6-9c39-e974a3a82447',
      sourceUrl:
        'https://www.denner.ch/de/aktionen/denner-poulet-kalbsbratwurst~p1003622?variant=17a93bff-db8f-43e6-9c39-e974a3a82447',
      title: 'Denner Poulet-Kalbsbratwurst',
      price: { current: 8.95, unit: { value: 960, per: 'g' } },
      originalPrice: 11.85,
      discount: { type: 'percentage', value: 24 },
    });
    expect(promotions[0].validUntil.toISOString()).toBe('2026-05-20T23:59:59.999Z');
    expect(promotions[1].price.unit).toEqual({ value: 6, per: 'l' });
  });

  it('throws a clear parse error when no promotion cards are present', () => {
    expect(() =>
      parseDennerPromotionsPage(
        '<html><body>No current actions</body></html>',
        'https://www.denner.ch/de/aktionen'
      )
    ).toThrow('Denner promotions page did not contain parseable product promotion cards.');
  });

  it('parses piece units from multipack descriptions', () => {
    const html = `
      <div>Bis 20.05.2026</div>
      <div class="product-item stretch-link">
        <span class="price-tag__final-price">4.50</span>
        <a class="product-item__title" href="/de/aktionen/test-eier~p1?variant=v1">Test Eier</a>
        <div class="product-item__subline">6 x 1 Stück</div>
      </div>
    `;

    const promotions = parseDennerPromotionsPage(html, 'https://www.denner.ch/de/aktionen');

    expect(promotions[0].price.unit).toEqual({ value: 6, per: 'piece' });
  });
});
