# Round 2 Fix Plan

## Bugs Found (from test-issues-round2.mjs)

### Bug 1: Migros search "apfel" returns 0 results (REAL BUG)
**Root cause:** Migros API fuzzy-matches "apfel" → "Appel" brand (German fish company). The `productMatches()` filter removes all results because taxonomy lacks an `apfel` key.

**Fix:** Add `apfel` to TAXONOMY in `src/util/matcher.ts`:
```typescript
apfel: ['apfel', 'apple', 'obst'],
```

### Bug 2 & 3: Coop/Aldi products "missing title" (TEST BUG)
**Root cause:** Test checks for `title` but `NormalizedProduct` uses `name`. The field exists and is populated.

**Fix:** Update test to check `name` instead of `title`.

### Bug 4 & 5: Source status capabilities (ALREADY FIXED)
**Status:** Fixed in previous session ("Source registry accuracy fix"). Test assertion was incorrect - checking nested structure wrong.

**Fix:** Update test to match actual API response structure.

## Implementation Steps

1. Fix Bug 1: Add `apfel` taxonomy key in `src/util/matcher.ts`
2. Fix test assertions for Bugs 2-5 in `scripts/test-issues-round2.mjs`
3. Run all tests to verify
4. Commit and push
