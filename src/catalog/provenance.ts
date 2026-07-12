/**
 * Provenance enrichment for search results (Phase D).
 *
 * Extends each product result with metadata so consumers can distinguish
 * fresh retailer data / cached / stale fallback / search-discovered.
 *
 * Backward-compatible: all new fields are optional; existing PWA and MCP
 * clients keep working.
 */

import type { NormalizedProduct, SourceProvenance } from '../adapters/types.js';

export type DiscoveryMethod = 'vendor' | 'web-google' | 'web-ddg' | 'catalog';

export interface ProvenanceEnrichment {
  /** Which chain adapter produced this result. */
  source: string;
  /** How the product was discovered. */
  discoveredBy: DiscoveryMethod;
  /** Adapter id when hydration occurred (e.g., after web discovery). */
  hydratedBy?: string;
  /** When product data was fetched (ISO timestamp). */
  observedAt: string;
  /** When the price was fetched (may differ from observedAt). */
  priceObservedAt: string;
  /** Served from a stale-fallback cache window. */
  stale: boolean;
  /**
   * Heuristic confidence score (0..1):
   *   - 1.0: fresh vendor hydration (live API call, no cache)
   *   - 0.9: fresh cache hit (soft TTL)
   *   - 0.7: needs-refresh cache hit (soft expired, hard valid)
   *   - 0.5: stale fallback cache (stale window, provider failed)
   *   - 0.3: catalog-only result (no fresh vendor data)
   *   - 0.2: web-discovered + hydrated (indirect source)
   */
  confidence: number;
}

/**
 * Compute a confidence score based on the discovery and freshness context.
 *
 * Heuristic documented in code:
 *   fresh vendor hydration (live API, no cache)       → 1.0
 *   fresh cache hit (soft TTL)                         → 0.9
 *   needsRefresh (soft expired, hard valid)            → 0.7
 *   stale fallback (provider failed, used stale data)  → 0.5
 *   catalog-only (no fresh vendor data)                → 0.3
 *   web-discovered + hydrated (indirect source)        → 0.2
 */
export function computeConfidence(context: {
  discoveredBy: DiscoveryMethod;
  stale: boolean;
  cacheFresh?: boolean;
  cacheNeedsRefresh?: boolean;
}): number {
  if (context.discoveredBy === 'catalog') {
    return 0.3;
  }

  if (context.discoveredBy === 'web-google' || context.discoveredBy === 'web-ddg') {
    return 0.2;
  }

  // Vendor discovery
  if (context.stale) {
    return 0.5;
  }
  if (context.cacheNeedsRefresh) {
    return 0.7;
  }
  if (context.cacheFresh) {
    return 0.9;
  }
  // Fresh vendor hydration (no cache involved)
  return 1.0;
}

/**
 * Enrich a NormalizedProduct with provenance fields.
 * Returns a new object (does not mutate the original).
 */
export function enrichProductWithProvenance(
  product: NormalizedProduct,
  enrichment: ProvenanceEnrichment
): NormalizedProduct {
  const base: SourceProvenance = {
    provider: enrichment.source,
    sourceType: 'retailer-web',
    observedAt: enrichment.observedAt,
    freshness: enrichment.stale ? 'stale' : 'live',
    confidence: enrichmentToSourceConfidence(enrichment.confidence),
  };
  return {
    ...product,
    provenance: {
      ...product.provenance,
      ...base,
    },
  };
}

/**
 * Map numeric confidence (0..1) to the existing SourceConfidence union.
 */
function enrichmentToSourceConfidence(
  confidence: number
): 'high' | 'medium' | 'low' {
  if (confidence >= 0.7) return 'high';
  if (confidence >= 0.4) return 'medium';
  return 'low';
}

/**
 * Attach provenance enrichment to a product result without changing
 * the NormalizedProduct type (uses a well-known symbol key for
 * backward-compat).
 */
const PROVENANCE_KEY = '__phaseD_provenance__' as const;

export function attachProvenance(
  product: NormalizedProduct,
  enrichment: ProvenanceEnrichment
): NormalizedProduct {
  const enriched = enrichProductWithProvenance(product, enrichment);
  // Use a non-enumerable property so JSON.stringify skips it by default
  // but programmatic consumers can read it.
  Object.defineProperty(enriched, PROVENANCE_KEY, {
    value: enrichment,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  return enriched;
}

/**
 * Retrieve the Phase D provenance enrichment attached via `attachProvenance`.
 * Returns undefined if not attached.
 */
export function getProvenance(
  product: NormalizedProduct
): ProvenanceEnrichment | undefined {
  return (product as unknown as Record<string, unknown>)[PROVENANCE_KEY] as
    | ProvenanceEnrichment
    | undefined;
}
