/**
 * Query normalization for catalog search.
 *
 * Lowercases, strips punctuation, collapses whitespace, applies Unicode NFD
 * with combining-character removal, canonicalizes units, and performs basic
 * German plural folding.
 *
 * Deliberately preserves qualifiers like "laktosefrei"/"lactose-free" to
 * avoid over-normalizing distinct products.
 */

const GERMAN_PLURAL_RULES: ReadonlyArray<[RegExp, string]> = [
  [/\b(tomaten)\b/g, 'tomate'],
  [/\b(apfelsine[ns]?)\b/g, 'apfelsine'],
  [/\b(kartoffel[ns]?)\b/g, 'kartoffel'],
  [/\b(bananen)\b/g, 'banane'],
  [/\b(zitronen)\b/g, 'zitrone'],
  [/\b(erbsen)\b/g, 'erbse'],
  [/\b(kirsche[ns]?)\b/g, 'kirsche'],
  [/\b(himbeere[ns]?)\b/g, 'himbeere'],
  [/\b(erdbeere[ns]?)\b/g, 'erdbeere'],
  [/\b(blaubeere[ns]?)\b/g, 'blaubeere'],
  [/\b(mandarine[ns]?)\b/g, 'mandarine'],
  [/\bzwiebel[ns]?\b/g, 'zwiebel'],
  [/\bkarotte[ns]?\b/g, 'karotte'],
  [/\b(eier)\b/g, 'ei'],
  [/\b(nudel[ns]?)\b/g, 'nudel'],
  [/\b(äpfel)\b/g, 'apfel'],
  [/\b(birnen)\b/g, 'birne'],
];

function canonicalizeUnits(input: string): string {
  let result = input;

  // Liquids: process most specific first → all become ml
  result = result.replace(/\b(\d+(?:\.\d+)?)\s*ml\b/gi, (_, n: string) => `${Number(n)}ml`);
  result = result.replace(/\b(\d+(?:\.\d+)?)\s*cl\b/gi, (_, n: string) => `${Math.round(Number(n) * 10)}ml`);
  result = result.replace(/\b(\d+(?:\.\d+)?)\s*l\b/gi, (_, n: string) => `${Math.round(Number(n) * 1000)}ml`);

  // Weight: process most specific first → all become g
  result = result.replace(/\b(\d+(?:\.\d+)?)\s*kg\b/gi, (_, n: string) => `${Math.round(Number(n) * 1000)}g`);
  result = result.replace(/\b(\d+(?:\.\d+)?)\s*g\b/gi, (_, n: string) => `${Number(n)}g`);

  return result;
}

export function normalizeQuery(input: string): string {
  // First: lowercase, NFD normalize, strip combining marks
  let result = input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  // Unit canonicalization must happen BEFORE punctuation strip
  // because decimals like "0.5 kg" need the dot preserved
  result = canonicalizeUnits(result);

  // Now strip punctuation (but not spaces or alphanumeric)
  result = result
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const [pattern, replacement] of GERMAN_PLURAL_RULES) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

/**
 * Expand a query into a set of synonyms for FTS lookup.
 * The synonymMap should map each term to all terms sharing its canonical form
 * (bidirectional). Returns the original terms plus all their synonyms.
 */
export function expandWithSynonyms(
  terms: string[],
  synonymMap: Map<string, Set<string>>
): string[] {
  const expanded = new Set<string>();
  for (const term of terms) {
    expanded.add(term);
    const synonyms = synonymMap.get(term);
    if (synonyms) {
      for (const syn of synonyms) {
        expanded.add(syn);
      }
    }
  }
  return [...expanded];
}
