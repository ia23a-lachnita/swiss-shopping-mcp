import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { parseAldiProductPage, parseAldiProductSitemap } from './aldi.js';

async function readFixture(name: string): Promise<string> {
  return readFile(new URL(`../../fixtures/live-sources/aldi/${name}`, import.meta.url), 'utf8');
}

describe('Aldi parsers', () => {
  it('parses Aldi product sitemap entries', async () => {
    const xml = await readFixture('product-sitemap.sample.xml');

    const entries = parseAldiProductSitemap(xml);

    expect(entries).toEqual([
      {
        loc: 'https://www.aldi-suisse.ch/de/produkt/no-brand-fish-fingers-000000000000100049',
        lastmod: '2026-05-05',
      },
      {
        loc: 'https://www.aldi-suisse.ch/de/produkt/backbox-pizzasnack-margherita-000000000000100930',
        lastmod: '2026-05-05',
      },
      {
        loc: 'https://www.aldi-suisse.ch/de/produkt/backbox-toskanabrot-000000000000101698',
        lastmod: '2026-05-18',
      },
    ]);
  });

  it('parses product JSON-LD into an intermediate product record', async () => {
    const html = await readFixture('product-toskanabrot.sample.html');

    const product = parseAldiProductPage(html);

    expect(product).toEqual({
      id: 'backbox-toskanabrot-000000000000101698',
      sourceUrl: 'https://www.aldi-suisse.ch/de/produkt/backbox-toskanabrot-000000000000101698',
      name: 'Toskanabrot',
      brand: 'BACKBOX',
      price: {
        current: 2.19,
        currency: 'CHF',
      },
      category: 'Grillen',
      image: 'https://dm.emea.cms.aldi.cx/is/image/aldiprodeu/product/jpg/scaleWidth/300/8561b109-ffcc-4b42-9651-fbafb94fe4aa/Toskanabrot',
      availability: 'https://schema.org/InStock',
    });
  });

  it('prefers an explicit source URL when product offer URL is absent', async () => {
    const html = `
      <script type="application/ld+json">
        {
          "@context": "https://schema.org/",
          "@type": "Product",
          "name": "Probeprodukt",
          "offers": {
            "@type": "Offer",
            "price": "1.50",
            "priceCurrency": "CHF"
          }
        }
      </script>
    `;

    const product = parseAldiProductPage(
      html,
      'https://www.aldi-suisse.ch/de/produkt/probeprodukt-000000000000000001',
    );

    expect(product!.id).toBe('probeprodukt-000000000000000001');
    expect(product!.sourceUrl).toBe('https://www.aldi-suisse.ch/de/produkt/probeprodukt-000000000000000001');
  });

  it('throws a parse error when Product JSON-LD is missing', () => {
    expect(() => parseAldiProductPage('<html></html>')).toThrow('Product JSON-LD');
  });

  it('returns undefined when price is not numeric', () => {
    const html = `
      <script type="application/ld+json">
        {
          "@context": "https://schema.org/",
          "@type": "Product",
          "name": "Probeprodukt",
          "offers": {
            "@type": "Offer",
            "url": "https://www.aldi-suisse.ch/de/produkt/probeprodukt-000000000000000001",
            "price": "not-a-price",
            "priceCurrency": "CHF"
          }
        }
      </script>
    `;

    expect(parseAldiProductPage(html)).toBeUndefined();
  });
});
