/**
 * The one folding used by every matching decision in the product path.
 *
 * It lives in its own module so the matcher and the query vocabulary
 * (`queryUnderstanding.ts`) can both depend on it without depending on each
 * other — the vocabulary has to be normalised the same way it will be
 * compared, and a cycle between the two would make that a load-order accident.
 *
 * Note this folds umlauts by dropping the diacritic ("Käse" -> "kase"), which
 * is *not* what `src/eval/relevanceScoring.ts` does ("Käse" -> "kaese"). The
 * difference is deliberate: the scorer must not share the matcher's folding,
 * or it could never show the matcher getting worse.
 */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function tokenize(value: string): string[] {
  const normalized = normalize(value);
  return normalized.length === 0 ? [] : normalized.split(' ');
}
