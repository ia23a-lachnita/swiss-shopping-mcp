# PWA UX + Search Quality Fix Plan — 2026-07-30

Source: real-device feedback round 3 (4 screenshots + 13 reported issues).
Research: codebase root-causing + antigravity-mcp (`gemini-3.6-flash`) consulted on
UX best practices, backend fan-out architecture, search relevance, and a third
attempt at the loading indicator.

**Status: PLAN ONLY — nothing implemented yet.**

---

## 0. Executive summary

All 13 complaints were reproduced in code. None are cosmetic-only guesses —
each has a located root cause. Three findings matter most:

1. **The loading animation was never actually working.** `calc()` is invalid
   inside SVG `<rect>` `width`/`height` *presentation attributes*. The rect
   collapsed, so it drew a stub in one corner. The previous session verified
   the *animation* was running (`getComputedStyle` showed a live
   `stroke-dashoffset`) but never verified the *geometry* — the animation was
   genuinely running on a degenerate rect. That is the verification gap behind
   "war die Validierung mit verbundenen Augen?". Owning this: the check
   confirmed the wrong property.
2. **The cache is not broken — the fan-out is.** Adapters do cache (6–24h TTL,
   real short-circuit). But `Promise.all` + a 6000 ms per-adapter soft timeout
   means *any one unhealthy chain sets a ~6 s floor on every search*, warm cache
   or not. Six instant cache hits are invisible behind one dead chain. Plus the
   client's react-query cache is memory-only, so a page refresh always refetches.
3. **"Sihlcity geht nicht" is a one-line config bug.** GeoAdmin is queried with
   `origins: 'zipcode,gg25'` — ZIP codes and municipality boundaries only. A mall,
   street, or POI can *never* resolve. Meanwhile gibberish passes because the
   validation only runs on submit and fails open.

---

## 1. Issue register — root causes

| # | Report | Root cause | Location |
|---|--------|-----------|----------|
| 1 | Chat input sits high, drifts down as chat grows | `position: sticky` on a form placed *after* the message list in normal flow — it only pins once it would scroll out of view; with a short chat it just sits in flow | `pwa/src/components/ChatView.tsx:371` |
| 2 | No gap between content and bottom nav | `paddingBottom: var(--nav-h)` equals the nav's measured height *exactly* → zero gutter. `pb-4` exists ad-hoc on StatusView/CompareView only, hence "alle Tabs ausser Status" | `pwa/src/App.tsx:110`; `StatusView.tsx:38`, `CompareView.tsx` |
| 3 | Search animation broken and ugly | (a) `width="calc(100% - 2px)"` is invalid in an SVG geometry **attribute** → rect collapses to a corner stub. (b) `stroke="currentColor"` resolves to `--color-brand-ink` (#1b1206, near-black) on gold → reads as a smudge | `pwa/src/components/ui/button.tsx:52-64` |
| 4a | Any nonsense location accepted | `checkLocation()` runs only inside `submit()`, and fails open on error. Typing sets the pill unconditionally | `AvailabilityView.tsx:162-176`, `:274` |
| 4b | "Sihlcity" not found (it exists) | `origins: 'zipcode,gg25'` restricts GeoAdmin to ZIPs + municipalities; malls/POIs/streets are excluded by construction | `src/util/geo.ts:358`, `:461` |
| 5 | "Unterhaltung löschen" resets to tab 1 and wipes other tabs | `clearChatHistory().then(() => window.location.reload())` — a full reload | `ChatView.tsx:388` |
| 6 | Reload wipes everything, always lands on tab 1 | Active tab is plain `useState`; no persistence, no URL state | `App.tsx:49` |
| 7 | ETA always says ~18 s, always finishes earlier | Server sends each chain's **max-ever** latency; client takes `Math.max()` across chains → worst-case-of-worst-cases. Set once at stream open, never updated as chains report in | `src/web/server.ts:184-186`; `SearchView.tsx:69-77, 79-86` |
| 8 | Counter shows 27, final list shows 12 | `productsSoFar += result.data.length` counts **pre-limit** per-chain results; the response then applies `limit: 12` | `src/services/searchService.ts:219`; `SearchView.tsx:66` |
| 9 | No quick way to clear an input | `Input` is a bare `<input>` with no clear affordance | `pwa/src/components/ui/input.tsx` |
| 10 | Chips / icon buttons too bright | Selected state is full-saturation `bg-brand` (#cca23e) fill on #17181a | `SearchView.tsx:157`, `AvailabilityView.tsx` |
| 11 | Only one chat conversation | History is a single IndexedDB record under fixed key `'messages'` | `pwa/src/lib/chatHistory.ts:9` |
| 12 | Poor relevance at every vendor ("Milchdrink UHT" → Milchschokolade) | Raw query passed to each vendor's weak site search; results merged with no re-ranking; local matcher does token AND-match that also hits **ingredient text** | `src/util/matcher.ts`, `searchService.ts` |
| 13 | Cache appears to do nothing | `Promise.all` + global 6000 ms soft timeout → one bad chain sets a ~6 s floor regardless of cache. Client react-query cache is memory-only, lost on refresh | `searchService.ts:195-220`; `src/util/timeout.ts`; `App.tsx:18-26` |

---

## 2. Decisions taken (with rejected alternatives)

### 2.1 Chat layout — flex column, not sticky
Chat tab becomes `h-[calc(100dvh-var(--nav-h)-var(--header-h))] flex flex-col`,
message list `flex-1 overflow-y-auto min-h-0`, composer `shrink-0` as a normal
flex child. Add `interactive-widget=resizes-content` to the viewport meta so
Android Chrome shrinks the layout viewport instead of overlaying the keyboard.

*Rejected:* `position: fixed` composer (fights the keyboard, needs VisualViewport
JS); keeping `sticky` (cannot express "always at bottom" when content is short).

### 2.2 Nav clearance — one global token
`--nav-clearance: calc(var(--nav-h) + 1rem)` applied once on `<main>`. Remove the
ad-hoc per-view `pb-4`. Safe-area inset stays **only** on the nav (it is already
inside the measured `--nav-h`); adding it again to content would double-count.

### 2.3 Loading indicator — **owner decision (2026-07-30): keep the border animation, make it clean**

The owner confirmed the intended design was right; it was the *execution* that
was broken. Attempt #2 was never seen working. So: **repair the border trace,
do not replace it**, and keep the live-progress text line beneath it.

Required fixes:
- **Geometry.** Never put `calc()` in an SVG geometry *attribute*. Size the rect
  via CSS geometry properties (or an equivalent that tracks the button's border
  box), so the trace follows the full perimeter at the correct 8px radius on a
  variable-width button.
- **Colour.** Drop `stroke="currentColor"` — on a gold button it resolves to the
  near-black label colour and reads as a dark smudge. Use a translucent light
  stroke so it reads as an illuminated trace.
- **Motion.** Keep it clean and smooth; no glow, no shine.
- **Text.** The "N Ergebnisse bisher (x/7 Händler) · noch ~Ns" line stays — it is
  wanted — but its two lies get fixed in Phase 3 (issues 7 and 8).

*Rejected (antigravity's proposal):* a 7-segment concurrency track replacing the
border. Good idea in the abstract, but the owner wants the border treatment.

*Verification gate:* assert a non-degenerate `getBoundingClientRect()` on the
rect and capture a mid-flight screenshot. Checking only that the animation is
"running" is what let attempt #2 ship broken.

### 2.4 Tab state — History API, no router
Sync the active tab to `?tab=` via `pushState` + `popstate`. Survives reload and
makes the Android back button walk tabs instead of closing the PWA.

*Rejected:* React Router (heavy for one concern); sessionStorage (no back-button
integration).

### 2.5 Clear conversation — no reload, ever
`setMessages([])` from `useChat` + clear IndexedDB. The reload was the entire
cause of issues 5 and 6's collateral damage.

### 2.6 Location — widen origins AND validate as you type
Add `address`, `gazetteer`/`sn25`, and POI origins to the GeoAdmin call so
Sihlcity resolves. Validate on blur/selection (not only submit) and mark the
pill invalid inline. Keep fail-open on network error, but never render a
confirmed-invalid location as an accepted pill.

### 2.7 Chips — tinted, not filled
Selected chip: `bg-brand/15` + `border-brand` + bright gold text (~#e5be59),
≈6.8:1 contrast. Unselected stays sunken neutral.

### 2.8 Progress honesty
Counter counts **post-limit, currently-displayed** results — a number that only
grows. Never show a total that later shrinks. ETA switches to **p75 per chain**,
recomputed over *pending* chains only as each reports in; on overrun, swap the
countdown for "Ergebnisse werden zusammengeführt…" instead of showing 0 s.

### 2.9 Fan-out performance — 4 layers, in order
1. **Per-chain timeout budgets** instead of one global 6 s (API ~1.5 s,
   scraper ~3 s, Playwright ~4.5 s), with real `AbortController` cancellation —
   `raceWithTimeout` currently abandons the wait but leaves the work running,
   leaking sockets and Playwright contexts.
2. **Wire in the existing `sourceCircuitBreaker.ts`**, which is not on this path
   today. A known-dead chain must cost 0 ms, not 6000 ms. Config to avoid
   flapping: ≥5-request volume threshold, open at ≥40 % failures in a 30 s
   window, 30 s half-open, 2 consecutive successes to close.
3. **Whole-query cache + stale-while-revalidate** in front of the fan-out.
   Never cache a `partial` result set — that would propagate one chain's failure
   to every future hit.
4. **Persist the client react-query cache** to IndexedDB so a refresh paints
   instantly.

Progressive rendering (drawing each chain's results as they land) is worth doing
too, but note it fixes *perceived* speed for new queries only — it does nothing
for the refresh case, which is what was actually reported.

### 2.10 Relevance — lexical, no embeddings
Add a re-ranking pass over the merged result set:
field weighting (name ≫ brand > category ≫≫ ingredients), exact-phrase and
prefix bonuses, token overlap, and a hard penalty when query tokens hit
**only** ingredient text — which is exactly what promotes a chocolate bar to a
"Milch" query. German compounds (Milchdrink / Milchschokolade / Kokosnussmilch
all contain "milch") handled by a dictionary-driven decompounder seeded from the
existing SQLite FTS5 catalog vocabulary, including Fugen-S handling.

*Rejected:* on-device embeddings — ~300–900 ms and ~400 MB on a Pi, versus
1–4 ms for lexical scoring. Not justified. If semantic reach is needed later,
precompute a synonym table offline (Poulet↔Hähnchen) rather than doing vector
math at request time.

Guarded by a golden set (50–100 labelled Swiss grocery queries, with both
`must_include` and `forbidden_in_top_5`), scored by MRR + P@5, run in CI.
This is the only way this stays fixed.

### 2.11 Multi-conversation chat
IndexedDB v2: a `conversations` store (`id`, `title`, `createdAt`, `updatedAt`,
`messages`), auto-titled from the first user message, sorted by `updatedAt`.
One-time migration wrapping the existing `'messages'` record as a legacy
conversation. UI: a history sheet from the chat header, with per-item delete.

---

## 3. Proposed phasing

**Phase 1 — Layout & state correctness (highest annoyance / lowest risk)**
Issues 1, 2, 5, 6. Chat flex layout, global nav clearance, no-reload clear,
tab state in the URL.

**Phase 2 — Input & visual polish**
Issues 3, 9, 10. Loading indicator rebuild (wired to real chain progress),
input clear buttons, chip recalibration.

**Phase 3 — Honest progress**
Issues 7, 8. p75 ETA over pending chains, monotonic result counter,
per-chain source status surfaced in the stream.

**Phase 4 — Fan-out performance**
Issue 13. Per-chain budgets + AbortController, circuit breaker on the path,
whole-query SWR cache, persisted client cache.

**Phase 5 — Location correctness**
Issue 4. GeoAdmin origins widened, validation on blur, inline invalid state.

**Phase 6 — Relevance**
Issue 12. Re-ranker, decompounder, ingredient penalty, golden set + CI metric.

**Phase 7 — Multi-conversation chat**
Issue 11. IndexedDB v2 + migration + history sheet.

Phases 1–3 and 5 are self-contained and safe to land quickly. Phase 4 touches
the request path and needs care. Phase 6 is the largest and should not start
until its golden set exists — otherwise there is no way to tell improvement
from regression.

---

## 4. Verification requirements

Per `CLAUDE.md`'s manual testing contract, every phase needs real in-browser
verification, not just green tests. Specific to this round, given how attempt #2
failed:

- **Verify rendered geometry, not just computed style.** For the loading
  indicator, assert the element's `getBoundingClientRect()` is non-degenerate
  and screenshot it mid-flight. A running animation on a collapsed element is
  exactly what passed review last time.
- Test the chat composer with the **keyboard open** on a real viewport, not only
  headless — the previous `dvh` gap is a known limitation of headless Chromium.
- Reload and back-button behaviour must be checked in an **installed** PWA
  context, where it differs from a browser tab.

---

## 5. Open questions for the owner

1. Phase order — is the annoyance ranking above right, or should relevance
   (Phase 6) jump the queue? It is the biggest quality problem but also the
   largest and slowest to land.
2. Loading indicator: confirm the 7-segment real-progress track before it is
   built, given two prior rejections.
3. Multi-conversation chat: is a history sheet enough, or is renaming/pinning
   wanted too?
