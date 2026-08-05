/**
 * Ask each web-search provider, one at a time, what it actually returns from
 * this machine — HTTP status, body shape, parsed result count.
 *
 * The composite provider deliberately hides all of that: it walks the chain,
 * swallows each failure, and reports one aggregate outcome. That is right for
 * production and useless for diagnosis, because "web augmentation contributed
 * nothing" has at least three causes that look identical from the outside — the
 * endpoint refused us, the endpoint served us and the parser found nothing in
 * it, or the endpoint genuinely has no results for this site: query. Only the
 * first is fixed by running somewhere else, so guessing wrong means capturing
 * from the wrong machine and learning nothing.
 *
 * Run from the repo root after `npm run build`:
 *   node scripts/probeWebSearch.mjs [query] [site]
 */
const query = process.argv[2] ?? 'Milchdrink UHT';
const site = process.argv[3] ?? 'migros.ch';

const { parseDuckDuckGoHtml } = await import('../dist/sources/webSearch.js');

const ENDPOINTS = [
  { name: 'ddg-html', url: 'https://html.duckduckgo.com/html/' },
  { name: 'ddg-lite', url: 'https://lite.duckduckgo.com/lite/' },
];

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

console.log(`query "${query}" site:${site}\n`);

for (const endpoint of ENDPOINTS) {
  const target = `${endpoint.url}?q=${encodeURIComponent(`site:${site} ${query}`)}`;
  let response;
  try {
    response = await fetch(target, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
      },
    });
  } catch (err) {
    console.log(`${endpoint.name.padEnd(9)} THREW ${err?.message ?? err}`);
    continue;
  }

  const html = await response.text();
  // The two markers the provider itself checks for before parsing, reported
  // separately from the status: a challenge served as 200 is the case that
  // reads as "success, no results" and is the whole reason this script exists.
  const challenge = html.includes('anomaly-modal') || html.includes('challenge-form');
  let parsed = -1;
  try {
    parsed = parseDuckDuckGoHtml(html, site, 10).length;
  } catch (err) {
    console.log(`${endpoint.name.padEnd(9)} parser threw: ${err?.message ?? err}`);
  }

  console.log(
    `${endpoint.name.padEnd(9)} HTTP ${response.status} · ${String(html.length).padStart(7)} bytes · ` +
      `challenge=${challenge} · parsed=${parsed}`
  );

  // A body that is large, unchallenged and still parses to nothing is parser
  // rot, not an egress problem — so print enough of it to tell which.
  if (!challenge && parsed === 0 && html.length > 2000) {
    const anchors = (html.match(/<a\s[^>]*href=/gi) ?? []).length;
    const resultClass = (html.match(/class="[^"]*result[^"]*"/gi) ?? []).slice(0, 3);
    console.log(`          anchors=${anchors} result-ish classes: ${resultClass.join(' , ') || 'none'}`);
  }
}
process.exit(0);
