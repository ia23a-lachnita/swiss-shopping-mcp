# Search-relevance golden set

The gate that has to exist before anyone touches ranking. Without it there is no
way to tell an improvement from a regression, because both look like "the
results changed".

## Running it

```bash
npm run eval:relevance     # score the frozen fixtures (offline, ~1s)
npm run eval:capture       # re-capture fixtures from live vendors (~8 min)
```

`eval:relevance` runs as part of `npm test` and therefore in CI. It never hits
the network.

## How it is put together

| Piece | What it is |
|---|---|
| `goldenSet.ts` | 51 labelled queries in five buckets (compound, multiword, brand, category, romance) |
| `fixtures/*.json` | Candidate pools captured from the live 7-chain fan-out, frozen |
| `relevanceScoring.ts` | Folding, relevance judgement, P@5 / MRR / coverage |
| `baseline.json` | Committed metrics + the known-violation allowlist |
| `relevance.golden.test.ts` | The gate |

The suite ranks a **frozen candidate pool** with the production ranking
(`sortProducts`) and scores the top 5. That is deliberate: the score then moves
when the ranker moves, and not when a vendor has a bad afternoon.

## Decisions worth not re-litigating

**Labels are patterns, not product IDs.** Vendor IDs are per-chain and churn
whenever a catalogue is rewritten, so an ID-keyed corpus rots within weeks and
silently stops asserting anything. Names move far more slowly.

**Judgement sees name + brand, never category or tags.** Migros and Aldi put the
brand in `brand` and only the variant in `name` — a Toblerone bar is literally
named "Crunchy Almond", and judging on name alone scored the whole brand bucket
at 0.575 against results that were in fact correct. Tags are excluded because
that is where ingredient text reaches the matcher, and a judge that could see it
would happily agree that a chocolate bar is milk. `ScoredProduct` omits the
field entirely so no future edit can quietly start reading it.

**Two metric pairs, reported side by side.** `precisionAt5`/`mrr` cover queries
that returned something and are the ranking signal. `overallPrecisionAt5`/
`overallMrr` count every query, scoring an empty result set 0, because from the
user's side "no results" is a failed search and not an absent measurement. The
gap between them is currently large (0.991 vs 0.894) and that gap is the point:
a single headline number would flatter the system.

**Coverage is gated in its own right.** Otherwise a query-understanding change
that stops matching a hard class of queries would *raise* the ranking metrics by
removing those queries from the average.

**It is a ratchet, not a target.** A new top-5 violation on a `gate` query fails
the build — and so does a known violation that has been fixed but left in
`knownGateViolations`, so the allowlist cannot quietly become permission to be
wrong.

## Re-capturing fixtures

Fixtures are a snapshot of a live catalogue and will drift. Re-capture
deliberately and review the diff. Never re-capture to make a red build green —
that proves nothing and destroys the only baseline you had.

Capture uses a bare `SearchService` (no breaker, no cache) so the fixture is the
raw candidate pool rather than a cache artefact. The local SQLite catalog is
excluded from both tiers because its contents are environment-specific (a few
hundred rows here, a different set on the Pi) and fixtures captured against it
would not be reproducible.

## The web-augmentation tier

`npm run eval:capture -- --web` captures a second tier into `fixtures-web/` for
the subset in `WEB_TIER_QUERY_IDS`. It exists because augmentation injects
web-discovered products at the *head* of the merged list, so it can put a
product in the top 5 that the vendor tier never saw.

**No web fixtures are currently committed, and that is deliberate.** From this
machine the augmentation path cannot be exercised at all: the auto chain is
`ddg-html → ddg-lite → google-cse`, both DDG endpoints answer with an HTTP 202
bot challenge here, and google CSE returns a permanent 400 (it has been closed
to new customers since 2026-07-13). The four paid providers whose keys are
configured are deliberately *not* in the auto chain — that was decided
2026-07-25 on the grounds that DDG works through the deployed egress, so this is
a local-egress symptom and not necessarily a production one.

A capture run anyway produced pools identical to the vendor tier for 49 of 51
queries. Committing that would have reported coverage of the augmentation path
while asserting nothing about it, so it was discarded. The capture script now
stamps each web fixture with `augmented: true|false` by diffing against its
vendor counterpart, warns loudly when augmentation contributed nothing, and the
suite fails on any committed fixture with `augmented: false`.

To close the gap, run the web capture from an egress DuckDuckGo serves (the Pi),
and commit the result.

## Known state (2026-08-01)

- Ranking P@5 **0.991**, MRR **1.0** over 46 answered queries.
- End to end P@5 **0.894**, coverage **0.902**.
- 5 queries return nothing from any of the 7 chains: `geriebener-kaese`,
  `glutenfreies-brot`, `roter-thai-curry`, `lait-entier`, `jus-orange`. Both
  French queries are in that list, in a country that is ~23% francophone. This
  is a recall / query-understanding gap, not a ranking one.
- One non-gating violation: `Rüebli` ranks "Rüebli Kuchenstück" (carrot cake) at
  #3 for a carrot query.
- `knownGateViolations` is empty: neither reported defect (Milchdrink UHT →
  Milchschokolade, Protein Milch → bread) reproduces against this capture. They
  are **not** known to be fixed — `matcher.ts` last changed 2026-06-19, six
  weeks before they were reported, so no relevance logic changed in between.
  The likelier explanations are vendor data churn or the per-chain timeout
  dropping the offending adapter's results before they can be ranked; Aldi now
  returns zero results for "Protein Milch". Treat them as masked, not repaired,
  which is exactly why both remain armed as gate queries.
