# PWA UX fix plan — round 4 (2026-08-04)

Five items reported by the owner from real phone use of the deployed PWA, in
their words plus what the code actually does. Round 3's plan is
`PWA_UX_FIX_PLAN_2026-07-30.md`; this supersedes nothing in it, phases 6–7
there are still open.

Read `docs/active/IMPLEMENTATION_TRACKER.md` first, as always.

## Implementation status — all five shipped 2026-08-04

Each section below is the original analysis, kept as written. What actually
landed, and where it departed from the plan:

| # | Status | Landed as | Verified by |
|---|--------|-----------|-------------|
| 1 | done | Five stacked rects (`.button-loading-border--taper-1…5`, `index.css`; `button.tsx` renders the stack). **Departure:** each layer is centred by padding the dash *pattern* (`0 1.5 12 36.5`) rather than by a per-layer `stroke-dashoffset`, because dashoffset is the property the shared animation drives — this keeps one animation and one set of keyframes. Opacities are `0.15/0.24/0.38/0.55/1.0`, not a linear ramp: stacked alphas compose as `1-(1-a₁)(1-a₂)…`, so a flat 0.2 per layer would have plateaued at 0.67 and never reached full brightness. Round caps only on the outermost layer — on a 3-unit dash a round cap is wider than the dash and blooms the core. Both corrections came from the antigravity consult the plan asked for (gemini-3.6-flash). | Frozen-frame screenshots at four animation offsets (the taper is invisible in motion — a running animation looks plausible either way) |
| 2 | done | `restartable` in `SearchView.tsx` (query *or* chain set differs while fetching) swaps the button to "Neue Suche starten"; `streamSearchProducts` now takes react-query's `signal` and closes the `EventSource` on abort; the SSE route stops writing once `req` closes. | Browser: stream A closed **without ever receiving `done`** at the click, stream B opened the same millisecond |
| 3 | done | The ETA is a *range* now, never a single confident number. The server sends `budgetMsByChain` (the hard per-chain budget, not the p75) and `postFanOutMs` (web augmentation + merge), and the client shows "noch 4–14s", falling back to "warte auf Aldi, bis zu 13s" once the likely time is spent but the budget is not. | Browser: observed all three states live, including the reported 6/7 straggler case |
| 4 | done | `limit: 12` removed from the PWA's search call. The clamp in `searchService` stays for callers that *do* pass a limit (it is still honest there) — it simply no longer applies to the app. Stagger is now `min(0.05, 0.9/count)` so 80 cards still settle in under a second. | Browser: "Milch" renders 84 products, last card fully opaque. Measured first: 66–80 products / ~80KB for a broad query |
| 5 | done | Server: `textToolCall.ts` (parser) + `textToolCallMiddleware.ts` (a language-model middleware that rewrites the provider stream, since the repair hook is unreachable here) — layer 1. Client: `ChatView.tsx` never renders tool-call syntax and shows an explicit failed-turn state with a retry — layers 2 and 3. Layer 4: the lineup was re-verified against the live catalog (see §5 below); no model change. | Unit test replays the field sample verbatim; browser test with a stubbed `/api/chat` for both the leaked-syntax and the empty-turn case |

Not done, and deliberately: the server still runs the fan-out to completion
after a client abort (tracker item 4, needs a real `AbortController` through
`ChainAdapter.searchProducts`), and the out-of-order transcript noted at the
end of §5 was not reproduced — `submit()` refuses to send while a turn is in
flight, so the ordering path that produced it is still unexplained.

---

## 1. Loading trace needs a gradient, not a flat dash

> "the search button animation is finally the direction I wanted but not
> perfect […] the lines rotating around the button's border need to have a
> gradient, meaning more out of the center of the line they start to fade —
> that's how I wanted it and know it"

**Now:** `.button-loading-border` in `pwa/src/index.css` is an SVG `<rect>`
with `stroke-dasharray: 15 35` and an animated `stroke-dashoffset`, drawn at a
single flat colour (`--loading-trace`). Every dash therefore has hard ends and
uniform opacity along its length.

**Wanted:** each travelling segment tapers — brightest at its midpoint, fading
to transparent at both ends (a comet, not a bar).

**Why the obvious approaches do not work.** An SVG `<linearGradient>` on
`stroke` paints in *user space* across the whole shape, so the fade would be
keyed to position on the button, not position within the dash — the segment
would change brightness as it travels rather than carrying its own taper. A
`<mask>` with a gradient has the identical problem. A `conic-gradient` sweep
was already tried and rejected (documented in the CSS): it distorts unevenly on
a rounded rect, fast along the long edges and slow through the corners.

**Recommended approach — layered dashes.** Stack N copies of the same rect,
each with a shorter `stroke-dasharray` active length centred on the same
midpoint and a higher opacity, e.g. 5 layers at lengths 15/12/9/6/3 and
opacities 0.2/0.4/0.6/0.8/1.0, all sharing one animation so they travel
together. Stacked, they approximate a taper. This keeps the `pathLength="100"`
proportionality that makes the trace size-independent, stays pure CSS/SVG, and
does not touch the per-keyframe easing that already reads correctly.

Fallbacks if that looks banded on a real screen: a small `feGaussianBlur` on
the trace layer only (softens ends but also thickens the stroke), or a
JS/canvas path renderer with per-pixel alpha via `getPointAtLength` (full
control, heaviest, breaks the current CSS-only approach).

**Before implementing:** the owner's standing preference is to consult
`antigravity-mcp` on animation technique/easing first (model priority in
`CLAUDE.md`; it was disconnected during this session, so this was not done).
The earlier round's research produced the right *motion* but missed the taper.

**Verification:** screenshot mid-effect — a still frame is the only way to see
the taper; a running animation looks plausible either way. Also verify the
whole containment chain (`[&_svg:not(.loading-trace-svg)]:size-4` in
`button.tsx` has already collapsed this SVG once).

---

## 2. Changing the query mid-search should let you restart

> "when the user searches something but maybe notices he wanted to search
> something different, the app should notice the query is different […] the
> user should have the ability to press the search button to stop the current
> query search and start a new one with the new query. The button should say
> something like 'search new query' instead"

**Now:** `SearchView.tsx` submits by setting `submitted`, and the button is in
its loading state for the whole fan-out. While a search runs there is no way to
abandon it — the input can be edited, but the button does not react to that.

**Fix:**

1. Derive `queryChanged = query.trim() !== submitted?.query || chains differ`.
2. While `isFetching && queryChanged`, the button leaves its loading state:
   enabled, labelled for the new intent — suggest **"Neue Suche starten"** to
   match the existing German UI ("Wird gesucht…", "Ergebnisse bisher"). A
   variant naming the query (`Stattdessen «Pasta» suchen`) is warmer but
   truncates badly on narrow phones.
3. Pressing it aborts the in-flight stream and starts the new one.

**Cancellation is cheap on the client.** `streamSearchProducts`
(`pwa/src/api.ts:134`) uses `EventSource`, which has no `AbortSignal` but does
have `close()`. Wire react-query's `queryFn` `signal` to call `source.close()`
on abort, and changing `submitted` will then tear the old stream down by
itself.

**Server-side is a separate, larger thing.** Closing the EventSource stops the
client consuming, but the server keeps the fan-out running to completion —
that is tracker item 4 (no real `AbortController` through
`ChainAdapter.searchProducts`). Worth adding `req.on('close')` handling to the
SSE route so the server at least stops writing, but do not let item 4 block
this: the user-visible fix is client-side.

---

## 3. The ETA is confidently wrong

> "prediction of time left is still really unreliable — it told me 5s but took
> actually 12s […] a second different query gave the same. The prediction is
> too confident that it would be faster. It looked like only one vendor was a
> bit slower since it said 6/7 and the predicted time was already over"

**Now:** `pendingEtaMs` (`SearchView.tsx:58`) returns `Math.max()` of the
per-chain p75 estimates over chains that have not answered, counted down from
search start. When it runs out, `etaOverrun` swaps in a message.

**Three separate reasons it under-promises:**

1. **p75 is wrong 25% of the time by construction**, and the max of several
   p75s is not the p75 of the max — with 7 chains, at least one exceeding its
   own p75 is the *common* case, not the tail.
2. **The estimate never extends.** It is recomputed when a chain reports, but a
   straggler that blows through its own estimate does not push the number out;
   the countdown just hits zero. That is exactly the 6/7 case observed.
3. **It only models the vendor fan-out.** Web-search augmentation (up to 8s),
   catalog hydration and the merge/rank step are outside it, while the tool
   budget is 16s.

**Fix directions, in order of value:**

- Bound the estimate below by the slowest pending chain's *remaining budget*
  (`chainTimeoutMs`, `src/util/timeout.ts`) — the ETA must never claim less
  time than a chain is still allowed to take.
- Use a higher quantile (p90) for the slowest pending chain, or keep p75 and
  add an explicit straggler margin.
- Re-estimate on a timer, not only on chain events, and let the number grow.
- Prefer language that cannot be falsified: "bis zu 12s" / a range, or name the
  straggler once it is alone ("warte auf Migros…") — the data is already in
  `pendingChainsRef`. Users forgive a conservative estimate and punish a
  confident wrong one, which is the whole complaint here.

Round 3 already established the honest-progress principle for the product
counter; this is the same principle applied to time.

---

## 4. The result limit is arbitrary and the counter looks stuck

> "the results streaming is weird as well — it says 12 found but still is going
> even though 12 is like the display limit or not? Why is there even a limit,
> shouldn't we display everything found on the vendors?"

**Now:** `SearchView.tsx:88` hard-codes `limit: 12` on every search. The server
ranks, then slices to that limit, and the live counter is clamped to it
(`searchService.ts`, deliberate in round 3 — it stopped the counter promising 27
when the response held 12). So the counter parks at 12 while chains keep
reporting, which reads as stuck.

**The limit has no product justification** — it is a payload/render cap that
was never revisited. The owner's expectation (show everything the vendors
returned) is the right default for a comparison app.

**Fix:**

1. Raise the server-side limit substantially or drop it for this call, and let
   the client render progressively (the list is already virtualisable; a "mehr
   anzeigen" cut-off is the fallback if long lists hurt on mid-range phones).
2. Once the limit is gone, **remove the counter clamp** — it exists only
   because of the limit, and without it the clamp is what makes the counter
   look frozen.
3. Keep the round-3 invariant that the counter never over-promises: with no
   limit, "found so far" is exactly what will be displayed, so the two agree by
   construction.

Measure the cost before choosing: capture how many products a broad query
("Milch", "Brot") actually returns across seven chains, and check render time
on the phone rather than the dev machine.

---

## 5. The chat broke: raw tool-call syntax rendered as an answer

> "the chat broke. I wrote 'hello?' since it didn't look like anything was
> processing, the 'ich denke nach' text just vanished at some point"

**What the screenshot shows.** The assistant's final bubble is not prose, it is
the model's own tool-call template rendered verbatim:

```
<tool_call>
<function=lookup_store_product_availability_storeId>
5537? Actually we need to pass: { chain: "coop", storeId: "5532", query: "almond milk"}
```

Three separate failures, in order:

**(a) The model emitted a text-form tool call instead of a structured one.**
The primary model is `google/gemma-4-31b-it:free` (`src/agent/chatAgent.ts:14`).
Small free models fall back to writing Hermes/Qwen-style `<tool_call>` tags as
*content* rather than using the provider's tool-calling API. Note the mangled
name — `lookup_store_product_availability` with the parameter `storeId` glued
on — and the model arguing with itself mid-call ("5537? Actually we need to
pass:"). This is the same family as the already-known Gemma-4 wrong-parameter
behaviour that `toolCallRepair.ts` exists for.

**(b) `experimental_repairToolCall` cannot catch it.** That hook only fires
when the SDK *has* a tool call to repair (bad name, bad args). Here nothing was
ever parsed as a tool call, so no tool ran, and the text streamed straight
through as an assistant message.

**(c) The turn ended silently.** No tool result, no answer, and the thinking
indicator (`busy`, `ChatView.tsx:323`) simply went away when the stream
finished. From the user's side that is indistinguishable from a crash — hence
"hello?".

**Fix, in layers (each is independently worth having):**

1. **Salvage it server-side.** Add a text-form tool-call parser one layer above
   `toolCallRepair.ts`: detect `<tool_call>` / `<function=…>` in assistant
   text, recover the tool by longest-prefix match against `TOOL_NAMES` (which
   turns `lookup_store_product_availability_storeId` back into
   `lookup_store_product_availability`), extract the first balanced JSON object
   as arguments, then hand it to the existing repair path and continue the
   loop. The observed sample is recoverable by exactly this.
2. **Never render tool-call syntax as an answer.** Whatever the model does, the
   client must not print `<tool_call>` to a user. Treat a message matching that
   shape as a failed turn.
3. **Fail visibly.** A turn that ends with no assistant text, or with leaked
   syntax, needs an explicit error state and a retry affordance instead of the
   indicator vanishing. This is the same honesty principle as round 3's
   progress work.
4. **Reconsider the model.** `FALLBACK_MODEL_IDS` already lists alternatives,
   and the catalog comment warns the free tier rotates (snapshot 2026-07-29).
   Re-verify against `GET https://openrouter.ai/api/v1/models` and consider
   promoting a model with reliable structured tool calling to primary — layers
   1–3 are still needed regardless, since free models will keep doing this.

   **Re-verified 2026-08-04 against the live catalog:** all three configured
   ids are still listed and all three still declare `tools` support. Only 13
   free models declare tools at all today, so the lineup is not stale. **No
   model change made**, deliberately: the obvious candidate to promote
   (`openai/gpt-oss-20b:free`) would be a swap on reputation, not evidence,
   and the instrument that could decide it is the golden-eval
   (`npm run test:eval`), which asserts tool *selection* against the real
   model. Promote only on a run that shows the current primary losing.

   That run was attempted on 2026-08-04 and is **inconclusive**: 8 of 10 cases
   failed with upstream `429 free-models-per-min` from Google AI Studio's
   shared free pool, after the SDK's three retries. The eval fires its ten
   cases in parallel, which the free tier will not serve — so it measures
   rate limits, not tool selection, unless it is run serially or with a
   paid key. The two cases that did get through passed. Note also that
   OpenRouter's `models` fallback array did **not** rescue the 429s; do not
   assume it covers rate limiting.

**Also visible in the same screenshot:** the store-card results render *after*
the user's later "Hello?" message, so a slow turn's output can land below a
newer user message and read as a reply to it. Worth confirming whether the
transcript orders by arrival rather than by turn.

## Verification for all five

Browser-verify on a real device or emulated mobile viewport, not just the
desktop SPA — every one of these was found on a phone. The relevance eval
(`src/eval/`) says nothing about any of this, and note its known blind spot: it
is captured without a `CatalogService`, so it cannot see catalog-sourced
results at all.
