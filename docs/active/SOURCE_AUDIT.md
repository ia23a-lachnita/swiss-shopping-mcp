# Source Audit

Date: 2026-05-18
Status: initial audit for real-data migration

## Policy Decisions

- Retailer web adapters are acceptable only when robots.txt and terms review do
  not block the specific pages/endpoints, request rates are conservative, and
  provenance labels the source as `retailer-web`.
- Stale cache may be used only when explicitly labeled with
  `SOURCE_STALE_CACHE_USED` and `freshness: "stale"`.
- Unsolved chains should remain visible as `sourceWarnings` when requested,
  rather than silently disappearing.
- Paid third-party providers are acceptable only after explicit user approval.

## Summary

| Chain | Source candidates | Official? | Products | Prices | Promotions | Store stock | Terms/risk | Recommended adapter |
|---|---|---:|---:|---:|---:|---:|---|---|
| Migros | `https://www.migros.ch/sitemap.xml`, `https://www.migros.ch/en/product/{id}`, `https://shared.migros.ch/filialen/de.html` | yes | partial | partial | blocked | unknown | `robots.txt` disallows query URLs and promotion paths; internal APIs are not a public contract | `blocked` until a permitted product-source path is verified |
| Coop | `https://www.coop.ch/en/online-supermarket.html`, `https://www.coop.ch/sitemap.xml`, `https://www.coop.ch/en/store-finder` | yes | partial | partial | unknown | unknown | `robots.txt` disallows `/search*`, `?text=*`, `/ajax`, and cart/account paths; crawl-delay 5s | `blocked` for search; audit product pages only |
| Aldi | `https://www.aldi-suisse.ch/de/sitemap_products.xml`, `https://www.aldi-suisse.ch/de/sitemap_stores.xml`, product pages under `/de/produkt/...` | yes | yes | likely | unknown | no | robots allows product/store sitemaps and page URLs; search query URLs are disallowed | best first candidate for fixture-backed catalog adapter |
| Denner | `https://www.denner.ch/de/aktionen/aktuelle-aktionen`, `https://www.denner.ch/de/filialsuche` | yes | promotions only | promotion prices | yes | no | robots broadly allows public pages except checkout/shopping list/auth; no full product catalog found | promotions adapter candidate, not full search |
| Lidl | `https://www.lidl.ch/static/sitemap.xml`, `https://www.lidl.ch/p/export/CH/de/product_sitemap.xml.gz`, store finder sitemaps under `/s/de-CH/filialfinder/sitemap.xml` | yes | yes | likely | unknown | no | robots disallows `/q/search`; sitemap exports look usable for product/store discovery | fixture-backed catalog candidate after `.gz` parser check |
| Farmy | `https://www.farmy.ch/`, `https://www.farmy.ch/robots.txt` | yes | no | no | no | no | homepage states operations have ceased; several frontend API paths are disallowed | `blocked` unless business status changes |
| Volg | `https://www.volg.ch/standorte-oeffnungszeiten/`, `https://www.volg.ch/sitemap.xml` | yes | no | no | unknown | no | robots blocks GPTBot but not generic user agents; no product source found in first pass | store locator only, product search blocked |
| Otto's | `https://www.ottos.ch/de`, `https://www.ottos.ch/sitemap.xml`, category pages under `/de/supermarkt-weine` | yes | partial | partial | partial | no | robots disallows `/api/*` and `*/search*`; crawl-delay 10s | audit category/product pages only |

## Chain Notes

### Migros

- Evidence: public Migros Online content says the online range includes around
  12,500 products and prices match Migros stores for Migros products.
- Robots: `https://www.migros.ch/robots.txt` disallows `*?query=`,
  `*/offers/instore/`, `*/offers/coupons/`, and `*/promotion/`.
- Candidate source path: product detail pages from sitemap/product URLs, not
  search query pages.
- Fixture targets: one product detail page and the public store locator shell.
- Status: blocked for live search until a permitted product listing source is
  confirmed.

### Coop

- Evidence: public online-supermarket page claims a large assortment and same
  prices as Coop stores.
- Robots: `https://www.coop.ch/robots.txt` disallows `/search*`, `/*?text=*`,
  `/ajax`, cart/account paths, and sets `Crawl-delay: 5`.
- Candidate source path: product detail/category URLs from sitemap only.
- Fixture targets: one product page, one category page, and store finder page.
- Status: blocked for query search; product-page parser may still be useful.

### Aldi

- Evidence: robots lists product and store sitemaps directly:
  `https://www.aldi-suisse.ch/de/sitemap_products.xml` and
  `https://www.aldi-suisse.ch/de/sitemap_stores.xml`.
- Product pages such as
  `https://www.aldi-suisse.ch/de/produkt/backbox-toskanabrot-000000000000101698`
  respond with HTML containing JSON-LD and price terms.
- Candidate source path: sitemap crawl into a freshness-controlled cache, then
  product-page parser.
- Fixture targets: product sitemap XML, store sitemap XML, one product page,
  one store page.
- Status: best first candidate for Phase 2.

### Denner

- Evidence: current actions page exposes product names, promotion prices,
  validity windows, categories, and labels in public HTML.
- Robots: `https://www.denner.ch/robots.txt` allows public pages and disallows
  checkout, shopping list, and auth paths.
- Candidate source path:
  `https://www.denner.ch/de/aktionen/aktuelle-aktionen`.
- Fixture targets: current actions page HTML and one action detail page.
- Status: promotions adapter candidate; not a full product search source.

### Lidl

- Evidence: robots points to `https://www.lidl.ch/static/sitemap.xml`, which
  points to product sitemap export
  `https://www.lidl.ch/p/export/CH/de/product_sitemap.xml.gz` and store finder
  sitemaps.
- Robots disallows `/q/search?id=*`, so search URL scraping is blocked.
- Candidate source path: gzipped product sitemap plus product page parser.
- Fixture targets: product sitemap `.gz`, one product page, store finder
  sitemap.
- Status: viable catalog candidate after parser feasibility check.

### Farmy

- Evidence: homepage currently states in German and French that Farmy has ceased
  operations.
- Robots disallows checkout/cart/account and several frontend API paths.
- Candidate source path: none for runtime grocery data.
- Status: blocked.

### Volg

- Evidence: public site has store locator at
  `https://www.volg.ch/standorte-oeffnungszeiten/` and sitemap.
- No product catalog or price source found in first pass.
- Candidate source path: store locator only, subject to endpoint inspection.
- Status: source-auditing for stores, blocked for products/prices.

### Otto's

- Evidence: homepage exposes supermarket/wine product cards, but robots blocks
  `/api/*` and `*/search*`, with crawl-delay 10 seconds.
- Candidate source path: sitemap/category/product pages only if a parser can
  extract stable data without search/API endpoints.
- Fixture targets: sitemap, one supermarket category page, one product page.
- Status: source-auditing with high rate-limit caution.

## Recommended Phase 2 Pick

Start with Aldi for a fixture-backed catalog adapter because product and store
sitemaps are explicitly listed in robots.txt and product pages appear to contain
structured data. Denner is a good second slice for promotions, not general
product search.
