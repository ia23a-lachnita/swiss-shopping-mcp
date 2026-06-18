import { NormalizedProduct } from '../adapters/types.js';
import { normalize } from './matcher.js';

/**
 * Builds a dynamic taxonomy from product data.
 * Scans product names, brands, and categories to discover
 * which tokens co-occur across products, then maps each
 * token to its most frequent co-occurring siblings.
 */
export function buildTaxonomy(products: NormalizedProduct[]): Record<string, string[]> {
  if (products.length === 0) return {};

  // Step 1: For each product, extract the set of unique tokens across all fields
  const productTokens: string[][] = [];
  const tokenProducts = new Map<string, Set<number>>();

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const fields = [p.name, p.brand ?? '', p.category ?? '', ...(p.tags ?? [])];
    const tokens = new Set<string>();
    for (const field of fields) {
      for (const token of tokenize(field)) {
        tokens.add(token);
      }
    }
    const tokenArray = [...tokens];
    productTokens.push(tokenArray);

    for (const token of tokenArray) {
      if (!tokenProducts.has(token)) {
        tokenProducts.set(token, new Set());
      }
      tokenProducts.get(token)!.add(i);
    }
  }

  // Step 2: For each token, compute Jaccard similarity with other tokens
  // based on which products they appear in
  const taxonomy: Record<string, string[]> = {};
  const MIN_CO_OCCURRENCE = 2;
  const MAX_ALIASES = 8;

  for (const [token, productSet] of tokenProducts) {
    if (productSet.size < MIN_CO_OCCURRENCE) continue;

    const scored: Array<{ token: string; score: number }> = [];
    for (const [otherToken, otherProductSet] of tokenProducts) {
      if (otherToken === token) continue;
      if (otherProductSet.size < MIN_CO_OCCURRENCE) continue;

      // Jaccard similarity: |intersection| / |union|
      let intersection = 0;
      for (const idx of productSet) {
        if (otherProductSet.has(idx)) intersection++;
      }
      const union = productSet.size + otherProductSet.size - intersection;
      if (union === 0) continue;

      const score = intersection / union;
      if (score >= 0.05) {
        scored.push({ token: otherToken, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const aliases = scored.slice(0, MAX_ALIASES).map((s) => s.token);
    if (aliases.length > 0) {
      taxonomy[token] = aliases;
    }
  }

  return taxonomy;
}

function tokenize(value: string): string[] {
  const normalized = normalize(value);
  return normalized.length === 0 ? [] : normalized.split(' ').filter((t) => t.length >= 2);
}
