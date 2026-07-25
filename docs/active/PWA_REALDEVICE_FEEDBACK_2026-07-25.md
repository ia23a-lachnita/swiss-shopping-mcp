# PWA real-device feedback — 2026-07-25

Source: user testing the deployed v0.2.0 build on a physical Android phone (screenshots attached in
session, not reproduced here). Captured verbatim intent, grouped by theme, with root-cause notes
where already investigated. This is a raw backlog, not yet prioritized/scheduled — see "Triage" at
the bottom once antigravity's second opinion and user prioritization are in.

## A. Visual / branding

1. **Brand accent too orange** — reads too close to Claude Code's own orange/amber branding; needs a
   distinct hue (still warm/brass-adjacent per the design refresh, but shifted off Claude's color).
2. **App icon/manifest still old green; status bar shows old blue** — PWA icons (`scripts/generate-pwa-icons.mjs`
   output) were never regenerated after the warm-stone/brass token refresh, and `theme-color` meta in
   `pwa/index.html` is still `#2563eb` (leftover from the earlier blue design pass, tracker row "PWA design
   pass"), not synced to the new brand token. Confirmed via screenshot: Android status bar renders blue.
3. **Skeleton loaders blink instead of a gradient shimmer wipe** — current skeleton animation reads as a
   blunt opacity blink; wants a smoother sweeping-gradient shimmer (standard modern-app pattern).
4. **Search tab card design should match Availability tab's** — user prefers the Availability tab's card
   format and wants Search tab's `SearchView.tsx` cards brought in line with it, not the reverse.

## B. State & interaction bugs

5. **Switching tabs and back loses in-progress search/compare results** — `App.tsx`'s `VIEWS` record swaps
   the mounted component per tab (`ActiveView = VIEWS[tab]`), unmounting the previous view entirely; local
   `useState` results in `SearchView`/`CompareView`/`AvailabilityView` are lost on unmount. Needs either
   TanStack Query cache reuse (already in use for fetching — check `staleTime`/query key stability) or
   keeping all four views mounted and toggling visibility (same pattern already used for the availability
   list/map toggle after the earlier Leaflet remount bug).
6. **Tab switch into a screen with a text input auto-focuses it, popping the mobile keyboard** — likely an
   `autoFocus` prop on the query `<input>` in `SearchView`/`CompareView`/`AvailabilityView`; should not
   steal focus on mount from a tab switch.
7. **Invalid/nonsense location text still fires a real (slow) search** — `AvailabilityView`'s location field
   has no client-side validation before submit; wastes a full round-trip on garbage input. Add basic
   plausibility validation (non-empty, matches PLZ/place-name shape) before allowing submit.

## C. Layout / scroll bugs

8. **ProductSheet content is cut off — can't scroll far enough to see nutrition or the "open on page" link**
   (worse when opened from the Availability tab, where the MapLibre map eats most of the sheet's height
   first). Works correctly when opened from the Search tab (nutrition + ingredients fully visible/scrollable
   in that path) — so this is either a sheet height/scroll-container bug specific to the Availability→
   ProductSheet path, or the map's height isn't capped, pushing everything else out of the scrollable area.
9. **Nutrition section doesn't render at all in the Availability-tab ProductSheet** — related to #8, but
   distinct: even scrolling further doesn't reveal it in that screenshot, unlike the Search-tab path where
   nutrition values populate correctly. Needs checking whether the availability data path actually carries
   nutrition fields through, vs. a pure layout/scroll issue.
10. **No bottom padding on some views — content sits flush against the bottom nav** — confirmed in
    screenshot: `StatusView`'s "SYSTEM" cache/hydration/catalog row touches the nav bar directly, unlike
    `SearchView`'s result grid (which already has correct bottom spacing per the earlier nav-overlap fix).
    `StatusView` (and possibly `CompareView`) need the same bottom-spacing treatment.
11. **Map inside ProductSheet: scrolling on the map also scrolls the sheet behind it** — the MapLibre
    canvas isn't capturing/stopping scroll propagation, so a two-finger or single-finger drag on the map
    bubbles up into the vaul drawer's own scroll.
12. **Map has no "recenter on my location" control** — once panned/zoomed away, there's no way back to the
    user's own position without closing and reopening the sheet.

## D. Data / metrics

13. **Latency numbers in Status tab reset every session** — **confirmed root cause**: `MetricsCollector`
    (`src/util/metrics.ts`) has a working `loadSnapshot()` method, but it is **never called** at server boot
    in either `src/index.ts` or `src/web/server.ts` (only referenced in `metrics.test.ts`). Separately, even
    if it were called, `loadSnapshot()`'s restore logic never repopulates `latency.samplesByChain` at all —
    only `cacheHits`/`webSearch`/`hydration`/`catalog`/`googleQuota` are restored from the persisted JSON.
    So every process restart (i.e. every deploy) genuinely zeroes latency until fresh requests accumulate.
    Two-part fix: call `loadSnapshot()` at boot, and extend it to seed `latency.samplesByChain` (or an
    avg/max-only representation) from the persisted `latencySnapshot.byChain`.
14. **Cache "looks like every session has its own"** — partially a misread: `FileTtlCache` (product/store/
    availability data) is already a shared on-disk cache at `SWISS_SHOPPING_CACHE_DIR`, not per-session.
    The part that *is* genuinely session-scoped is the metrics/latency data (see #13) — worth clarifying to
    the user that this observation was accurate for metrics specifically, not the data cache.
15. **Results count + elapsed time display is liked** — keep it, but make it live during the request instead
    of only appearing after completion: show "X/Y chains responded" counting up as adapters return, plus an
    ETA estimate derived from the latest known per-chain latency (from the now-fixed #13 data) — and
    explicitly omit the ETA (not show a bogus "0s" or "?") when no latency history exists yet for that chain.

## E. Feature requests

16. **CompareView "Menge" input is confusing** — root cause: it's a flat pack-count multiplier
    (`compare_prices`'s `quantity` param, `totalPrice = price.current * quantity`), applied identically
    across products with different pack sizes/units (5dl vs 1l vs 250g). The field isn't labeled clearly
    enough to convey "how many packs", and doesn't help answer "cheapest per liter/kg" (which the backend
    already supports via `comparisonBasis: 'unitPrice'`, just not exposed in this UI). Needs: clearer label,
    a proper numeric stepper (+/− buttons) instead of raw keyboard entry, and consider surfacing the
    unit-price comparison mode.
17. **CompareView cards should open ProductSheet on click** — currently `CompareView` rows aren't
    clickable; `SearchView`/`AvailabilityView` already wire this pattern (`onClick={() => setSelected(product)}`).
18. **Filter changes should instantly re-filter already-fetched results client-side** instead of always
    re-querying the backend — needs scoping: chain/in-stock/open-now filters that only narrow what's already
    on screen are candidates; filters that require different backend data (different chain selection widening
    the fetch scope) still need a real re-query. Needs a design decision on which filters get which behavior.
19. **Query autocomplete** — real (dynamic, not hardcoded) suggestions as the user types, for both the
    product-query and location fields.
20. **Location field autocomplete** — same idea as #19, scoped to PLZ/place names (GeoAdmin already used
    server-side for geocoding — could back a suggestion endpoint).
21. **Toast redesign**: "Standort aktualisiert" (and other toasts) currently render `top-center` (sonner
    default, `App.tsx:114`). Wants: positioned bottom, just above the nav bar; a left-to-right receding
    progress bar showing time until auto-dismiss; swipe-to-dismiss. Sonner supports `position="bottom-center"`
    natively; the progress bar and swipe affordance need a custom toast renderer (sonner supports custom JSX
    content via `toast.custom()`).
22. **Location input sizing transition is jarring** — full-size input pre-search collapses into a small pill
    post-search, leaving what reads as an empty "hole" in the layout; wants a smoother/less jarring transition
    between the two states.

## F. Open architecture questions (need discussion, not blind implementation)

23. **Web search sourcing** — RESOLVED and IMPLEMENTED 2026-07-25 (see "Web search provider chain rework"
    tracker row). User's ask: stop
    using the paid quota-limited chain, use "what agent CLIs use" instead. Feasibility gate closed via
    antigravity (gemini-3.6-flash) second opinion + live empirical testing (patchright and nodriver/
    stealth-browser-mcp both hard-blocked on a cold `site:` query against Google and Bing; the existing
    keyless DDG html-lite provider did not) + a real production test through the Pi's actual Gluetun/
    ProtonVPN egress (`docker exec` via `tailscale ssh`: 200 OK, 1996ms, 12 results, no bot-challenge).
    Findings:
    - "What agent CLIs use" (Claude Code's `WebSearch`, Gemini grounding) is a paid, hosted, first-party
      server-side tool run by Anthropic/Google on their own infra — not browser automation, not free, and
      not callable by this backend without adding an LLM API key + per-search+per-token billing. Confirmed
      via the `claude-api` skill: `web_search_20260209` server tool, billed, agent-side only.
    - No free/open-weight model (DeepSeek, MiniMax-family, Qwen, Kimi, Llama, GLM — i.e. what opencode's
      free-tier models are built on) bundles search either; only the four paid frontier labs do.
    - Browser automation (patchright / nodriver) does **not** outperform the existing plain-fetch DDG
      provider for generic search — it's slower, heavier, and got blocked on Google/Bing on the very first
      try (IP-reputation + `site:`-operator signature, not a fingerprint problem stealth tooling fixes).
    - Real prod metrics (`GET /api/metrics` → `webSearch`) show DDG has been invoked **0 times** in the 12
      real searches served so far — the paid chain has absorbed all of them — so this was previously
      untested in production; now it is, and it works.
    - Gluetun/ProtonVPN is confirmed load-bearing for at least Migros (abuse-detection blocks the Pi's bare
      egress IP, per the "Self-hosted CI/CD deploy pipeline" tracker row) — it is not there for search and
      is not being removed.

    **Decided plan (not yet implemented):** promote the existing keyless `DuckDuckGoHtmlProvider` to primary
    in `src/sources/webSearch.ts`'s `auto` chain; add `lite.duckduckgo.com` as a same-shape keyless secondary
    fallback; drop SerpAPI/HasData/Searlo/Firecrawl from the default chain (keep the provider classes and
    explicit non-default modes for an opt-in burst if ever needed); add a short in-memory TTL cache on search
    queries to reduce duplicate upstream hits. No SearXNG, no browser-automation search — both evaluated and
    rejected for this use case (see findings above).

    **Optional follow-up, not required, not scoped further:** once DDG is primary its latency starts to
    matter more than it does today (0 hits so far) — the VPN hop adds ~1.3s per search request (736ms direct
    vs 1996ms through Gluetun in side-by-side testing). If that ever becomes worth optimizing, the correct
    mechanism is: move the `swiss-shopping` container off `network_mode: service:gluetun` onto a normal
    bridge network alongside gluetun, enable gluetun's built-in HTTP/SOCKS5 proxy, and route only
    vendor-adapter HTTP/Playwright traffic through it (`http://gluetun:<proxy-port>`) while `webSearch.ts`'s
    `fetch()` calls go out direct/unproxied. Not a correctness fix (DDG already works fine through the VPN)
    — pure speed optimization, skip unless it's actually felt.

## G. Follow-up real-device findings (2026-07-25, second test pass)

24. **Toast overlaps the bottom nav and isn't easily swipe-dismissible** — real Android screenshot showed the
    "Standort aktualisiert" toast rendered flush against/over the nav instead of floating above it with a gap.
    Root cause: `App.tsx`'s `Toaster offset={{ bottom: 'calc(var(--nav-h) + 0.75rem)' }}` has no CSS fallback —
    if `--nav-h` is unset at the moment the browser evaluates the `calc()`, the whole custom-property value is
    invalid and sonner silently falls back to its own built-in default offset (which has no awareness of the
    fixed nav), reproducing exactly this overlap. Separately, sonner's default `swipeDirections` for
    `position="bottom-center"` resolve to `['bottom', 'center']` — `'center'` isn't a real direction, so only a
    downward swipe (awkward this close to the screen edge/nav) was ever recognized. **Fixed**: added a static
    fallback (`calc(var(--nav-h, 4.5rem) + 0.75rem)`) and explicit `swipeDirections={['bottom', 'left', 'right']}`
    so a natural horizontal swipe also dismisses. Browser-verified the gap fix directly (headless, 390×844):
    toast now renders with a clear dark gap above the nav bar, nav fully visible below it — confirmed via
    screenshot, matching the fix. **Not fully verifiable in this environment**: synthetic `PointerEvent`
    dispatch via CDP (`pointerdown`/`pointermove`/`pointerup`) did not register as a swipe with sonner's
    internal gesture handler (`data-swiped` stayed `false`) — consistent with the already-documented gotcha in
    this codebase that CDP-synthetic events don't always match native touch/pointer semantics (see the
    VendorBadge popover gotcha in the "PWA design refresh v2: vendor capability popover" tracker row). The fix
    itself (explicit swipe directions, standard sonner API) is sound and low-risk, but real-device confirmation
    of the swipe gesture specifically is still pending.
25. **Aldi has a second storefront (`aldi-now.ch`) with products not present on `aldi-suisse.ch`** — user found
    "GRANDESSA Schwarze Johannisbeere Konfitüre" in a real Aldi store and on `aldi-now.ch`, but searching
    "johannisbeermarmelade" in the app (Aldi only) returned "Keine Produkte gefunden". The current Aldi adapter
    (`src/adapters/live/aldiLiveAdapter.ts`) only scrapes `aldi-suisse.ch` — `aldi-now.ch` appears to be a
    separate site (different domain, different branding chrome, possibly a distinct quick-commerce/delivery
    catalog) with at least partially non-overlapping inventory. **Not yet investigated**: whether `aldi-now.ch`
    is a fully separate product catalog, a subset/superset of `aldi-suisse.ch`, what technology it's built on,
    and whether it's realistically scrapable the same way. This is new scope (a second Aldi source), not a bug
    fix — needs its own investigation pass before deciding whether/how to integrate it.

## Triage (pending)

Item 23 implemented 2026-07-25 (see tracker). Remaining open items from this backlog: 15 (live progress/ETA
during search), 16 and 18 (still need antigravity's second opinion + user prioritization before
implementation), 17 (small, no discussion needed), 19 and 20 (query/location autocomplete — also flagged for
antigravity + prioritization).
