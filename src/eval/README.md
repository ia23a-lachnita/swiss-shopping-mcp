# Search-relevance golden set

The gate that has to exist before anyone touches ranking. Without it there is no
way to tell an improvement from a regression, because both look like "the
results changed".

## Running it

```bash
npm run eval:relevance          # score the frozen fixtures (offline, ~1s)
npm run eval:capture            # re-capture fixtures from live vendors (~8 min)
npm run eval:capture -- --pool  # re-capture the PRE-filter pools (~2 min)
node scripts/reportPoolRecall.mjs [--write-baseline] [--dropped <id>]
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
| `fixtures-pool/*.json` | The same pools captured **before** our own relevance filter |
| `poolRecall.ts` + `poolBaseline.json` | Recall of that filter, per query |
| `poolRecall.test.ts` | The recall gate |

## Why there are two gates

Precision and recall need pools captured at different points, and for a long
time only one of them existed.

`fixtures/` is captured *after* `productMatches` has run, so every product the
filter wrongly discards is already missing from it. That gate reported P@5 0.98
on a system throwing away 45.4% of everything the vendors returned — including
every Migros pasta for the query "Teigwaren". It was not a bad gate; it was
being asked a question its input could not answer.

The fix was not a different kind of metric but an earlier snapshot.
`fixtures-pool/` records both sides of the filter's verdict, so recall is scored
offline and deterministically — **no live vendor call in CI**, which is why the
floors can be gated at all. `poolRecall.test.ts` ratchets the mean, holds a
per-query floor so an easy query cannot pay for a destroyed one, and hard-fails
any query whose relevant products are *all* discarded.

Some floors are low because the **labels** are generous rather than because the
filter is wrong: `ruebli` counts Purina cat food containing carrots as relevant,
`freilandeier` counts any plain egg. Those are label defects to fix in
`goldenSet.ts`. Raising the matcher to chase them would be optimising to a bad
label.

The suite ranks a **frozen candidate pool** with the production ranking
(`sortProducts`) and scores the top 5. That is deliberate: the score then moves
when the ranker moves, and not when a vendor has a bad afternoon.

## Decisions worth not re-litigating

**Labels are patterns, not product IDs.** Vendor IDs are per-chain and churn
whenever a catalogue is rewritten, so an ID-keyed corpus rots within weeks and
silently stops asserting anything. Names move far more slowly.

**A relevant label must land on the head of a German compound.** The last stem
of a compound says what the thing is: `Vollmilch` is a milk, `Milchschokolade`
is a chocolate, `Obstessig` is a vinegar. Judging by bare substring made the
corpus certify vinegar, schnapps and a Dr. Beckmann *stain remover* as fruit for
the query "Obst" and score it P@5 1.0 — the judge shared the matcher's substring
assumption, which is exactly why it could never see the matcher's substring
defect. `forbidden` deliberately still matches anywhere: "is this a kind of X"
is answered by the head, "does it carry trait Y at all" by any position, and
`Erdnussbutter` is forbidden for "Butter" through its modifier.

**Four verdicts on the ESCI scale, and `related` is the load-bearing one.**
E-commerce IR grades a query/product pair Exact / Substitute / Complement /
Irrelevant ([Reddy et al. 2022](https://arxiv.org/abs/2206.06588)). `relevant`
is Exact; `forbidden` is a defect we gate on; `related` is everything judged and
*not* Exact; `unjudged` means no label matched, which is **not** a synonym for
irrelevant.

`related` exists because the compound-head rule above is the *wrong* grammar for
a multi-word name. German compounds put the head last (`Him|beere` is a berry),
but retail titles put the product type **first** and the flavour after it —
`Früchtequark Aprikose` is a quark. So a fruit lemma legitimately matches a slot
that says nothing about what the product is, and a lemma list alone cannot tell
the two readings apart. Measured on 2026-08-06, that one confusion had "Gemüse"
scoring a **perfect P@5** on a top 5 holding a sweet-and-sour sauce, a vegan meat
alternative and a vegetable juice, with Felix *cat food* also labelled relevant;
"Obst" counted baby cereal, two quarks and three fruit bars as fruit while
leaving `Aprikosen`, `Datteln`, `Feigen` and `Pitahaya` unjudged. Naming the type
in `related` fixes both directions without teaching this judge to parse title
syntax — a corpus that exists to catch the ranker guessing must not contain a
second guesser.

S and C are collapsed into one verdict on the paper's own numbers: annotator
agreement is 91% on the full four-way taxonomy but >96% on Exact vs not-Exact
(§2.2). We score strict Exact precision and never use the split.

**`related` is not `forbidden`.** ESCI grades a fruit bar a Complement, and
failing a build over one would make the gate mean "unusual" rather than "wrong".
`forbidden` stays reserved for observed defects.

**`judged@5` is reported next to P@5, and ratcheted rather than gated.** P@5
scores an unlabelled product as non-relevant — the standard TREC pooling
assumption — and that holds only while the labels cover what is retrieved, which
nothing in P@5 announces. Reading precision without coverage is how a query
earns a good score for ranking products the corpus never had an opinion about,
and how a ranking *improvement* that surfaces correct-but-unlabelled products
gets recorded as a regression (see Buckley & Voorhees, SIGIR '04, which
introduced bpref for exactly this). It is deliberately **not** a hard gate on
"zero unjudged": pools are recaptured from live vendors, so new products arrive
on their own schedule, and failing the build for that would make red mean "the
catalogue changed" — which is how a suite gets ignored.

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
gap between them is the point: a single headline number would flatter the
system. They are identical today only because coverage is 1.0 — the pair still
has to stay reported, since the gap reopens the moment a query stops answering.

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

## Known state (2026-08-01, after query understanding)

- Ranking P@5 **0.98**, MRR **0.987** over 51 answered queries.
- End to end P@5 **0.98**, MRR **0.987**, coverage **1.0**.
- The two pairs are now identical because every query answers. They were
  0.991/1.0 against 0.894/0.902 before, and the answered-only pair going *down*
  while the end-to-end pair went up is the whole point of reporting both: the
  old 0.991 was a mean over the 46 easiest queries, because the 5 hardest
  returned nothing and were silently excluded.
- One non-gating violation: `Rüebli` ranks "Rüebli Kuchenstück" (carrot cake) at
  #3 for a carrot query.
- Two queries are scored below what they deserve, by the labels rather than by
  the ranker, and were left alone rather than relabelled to raise a number:
  `glutenfreies-brot` 0.8 (all five results are Schär gluten-free bread, but
  "Kaiserbrötchen" folds to `kaiserbroetchen` and so misses the `brot` lemma)
  and `jus-orange` 0.6 (`Fruchtsaft, Orange` is orange juice, but the pattern
  `orange.*saft` assumes the other word order).

### What made the last five answer

Both fixes are in `src/util/queryUnderstanding.ts`, and neither is a ranker
change:

1. **Modifier inflection.** Retailers write "Käse gerieben", shoppers write
   "geriebener Käse", and conjunctive substring matching discarded the product
   entirely. Query modifiers now match across inflection, and the *dispatched*
   query is canonicalised too — measured against the live fan-out, "geriebener
   Käse" returns one grated cheese among cheese-flavoured crisps while
   "gerieben Käse" returns eight grated cheeses.
2. **Romance translation.** The adapters query German catalogues, so no amount
   of local matching helps a French query — the products are never fetched.
   Fully-romance queries are translated before dispatch, all-or-nothing, so a
   single recognised word cannot hijack a brand query ("Emmi Caffè Latte").

A missing modifier costs rank rather than disqualifying — *except* for diet,
allergen and certification claims, which disqualify. Treating those as
preferences too put ordinary milk and coconut milk into the top 5 of
"laktosefreie Milch" and took it from 1.0 to 0.4.
- `knownGateViolations` is empty: neither reported defect (Milchdrink UHT →
  Milchschokolade, Protein Milch → bread) reproduces against this capture. They
  are **not** known to be fixed — `matcher.ts` last changed 2026-06-19, six
  weeks before they were reported, so no relevance logic changed in between.
  The likelier explanations are vendor data churn or the per-chain timeout
  dropping the offending adapter's results before they can be ranked; Aldi now
  returns zero results for "Protein Milch". Treat them as masked, not repaired,
  which is exactly why both remain armed as gate queries.
