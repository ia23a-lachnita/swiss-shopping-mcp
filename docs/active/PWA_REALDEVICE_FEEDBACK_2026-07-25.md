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

23. **Web search sourcing**: user's ask is to stop "weirdly using DuckDuckGo" and instead use "what agent
    CLIs use" for web search, to avoid the per-provider query quotas the current multi-provider chain
    (SerpAPI → HasData → Searlo → Firecrawl → Google CSE → DDG) works around. **Needs a feasibility gate**:
    agent-CLI web search (e.g. Claude Code's own `WebSearch` tool) is an *agent-side* capability available to
    an LLM session, not an API this Node/Express backend service can call at runtime — there is no public
    "Anthropic web search API" endpoint this server could hit the way it hits SerpAPI today. Get antigravity's
    take on whether there's a real alternative being conflated here (e.g. a specific provider's API agent CLIs
    happen to use under the hood) before deciding this is/isn't actionable.

## Triage (pending)

Not yet prioritized. Plan: get antigravity (gemini) second opinion on architecture items (16, 18, 23) and
overall phasing, then propose a phased plan to the user before starting implementation — this is too large
to execute as one uninterrupted session under the mandatory browser-verification-per-fix contract.
