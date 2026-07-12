/**
 * Observation validation layer for the product catalog (Phase D).
 *
 * Before a new observation replaces a previously credible value, this layer
 * flags suspicious data. Suspicious observations are stored as
 * 'pending_verification' rather than 'accepted'. A SECOND consistent
 * suspicious value (matching the first) promotes the observation to 'accepted'.
 *
 * Swiss-retail nuance: Coop/Migros legitimately run 50% promos. A price
 * arriving in the `promotionPrice` field is validated ONLY against the
 * promo>normal rule and sanity rules, NOT against the 75%-drop rule.
 * The drop rule applies to the NORMAL price field only.
 */

import type { ObservationStatus } from './types.js';

export interface ObservationInput {
  price: number | null;
  promotionPrice: number | null;
  currency: string | null;
  size: string | null;
  name: string | null;
}

export interface CredibleBaseline {
  price: number | null;
  promotionPrice: number | null;
  currency: string | null;
  size: string | null;
  name: string | null;
  status: ObservationStatus;
}

export interface ValidationResult {
  status: ObservationStatus;
  reason?: string;
}

const PRICE_DROP_THRESHOLD = 0.75;
const PRICE_SPIKE_THRESHOLD = 2.0;
const NAME_SIMILARITY_THRESHOLD = 0.6;

/**
 * Simple normalised Levenshtein-like similarity for product name comparison.
 * Returns 0..1 where 1 is identical after normalization.
 */
function normalizedSimilarity(a: string, b: string): number {
  const norm = (s: string): string =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/(\d)\s+(l|kg|g|ml|cl|stk|pack|s)(\b)/gi, '$1$2$3')
      .replace(/\s+/g, ' ')
      .trim();

  const na = norm(a);
  const nb = norm(b);

  if (na === nb) return 1;
  if (!na || !nb) return 0;

  // Quick containment check — very common in Swiss retail
  // (e.g., "Vollmilch 1l" vs "Migros Vollmilch 1L")
  if (na.includes(nb) || nb.includes(na)) return 0.85;

  // Token overlap (Jaccard-like)
  const tokensA = new Set(na.split(' '));
  const tokensB = new Set(nb.split(' '));
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Validate a new observation against a credible baseline.
 *
 * Rules applied to NORMAL price only:
 *   - price change > 75% down OR > 100% up → suspicious
 *   - zero or negative price → flagged
 *   - missing currency when price is present → flagged
 *
 * Rules applied to promotion_price:
 *   - promotion_price > normal price → flagged
 *
 * Cross-field rules:
 *   - package-size change on same product ID → flagged
 *   - product-name mismatch (normalized similarity < threshold) → flagged
 *
 * Swiss-retail nuance: promotion_price is NOT subject to the 75%-drop rule.
 */
export function validateObservation(
  incoming: ObservationInput,
  baseline: CredibleBaseline | undefined
): ValidationResult {
  // Rule 1: zero or negative price
  if (incoming.price !== null && incoming.price !== undefined && incoming.price <= 0) {
    return { status: 'pending_verification', reason: 'zero_or_negative_price' };
  }

  // Rule 2: missing currency when price is present
  if (
    incoming.price !== null &&
    incoming.price !== undefined &&
    incoming.price > 0 &&
    !incoming.currency
  ) {
    return { status: 'pending_verification', reason: 'missing_currency' };
  }

  // Rules that require a credible baseline
  if (baseline && baseline.status === 'accepted') {
    // Rule 3: promotion_price > normal price
    if (
      incoming.promotionPrice !== null &&
      incoming.promotionPrice !== undefined &&
      incoming.price !== null &&
      incoming.price !== undefined &&
      incoming.promotionPrice > incoming.price
    ) {
      return { status: 'pending_verification', reason: 'promo_exceeds_normal' };
    }

    // Rule 4: normal price change > 75% down or > 100% up (NORMAL price only)
    if (
      baseline.price !== null &&
      baseline.price !== undefined &&
      baseline.price > 0 &&
      incoming.price !== null &&
      incoming.price !== undefined &&
      incoming.price > 0
    ) {
      const changeRatio = (incoming.price - baseline.price) / baseline.price;

      // > 75% drop: new price is less than 25% of baseline
      if (changeRatio < -PRICE_DROP_THRESHOLD) {
        return {
          status: 'pending_verification',
          reason: `price_drop_${Math.round(Math.abs(changeRatio) * 100)}%`,
        };
      }

      // > 100% spike: new price is more than 200% of baseline
      if (changeRatio > PRICE_SPIKE_THRESHOLD - 1) {
        return {
          status: 'pending_verification',
          reason: `price_spike_${Math.round(changeRatio * 100)}%`,
        };
      }
    }

    // Rule 5: package-size change on same product ID
    if (
      baseline.size !== undefined &&
      baseline.size !== null &&
      incoming.size !== undefined &&
      incoming.size !== null &&
      baseline.size !== incoming.size
    ) {
      return { status: 'pending_verification', reason: 'size_changed' };
    }

    // Rule 6: product-name mismatch
    if (
      baseline.name !== undefined &&
      baseline.name !== null &&
      incoming.name !== undefined &&
      incoming.name !== null
    ) {
      const similarity = normalizedSimilarity(baseline.name, incoming.name);
      if (similarity < NAME_SIMILARITY_THRESHOLD) {
        return { status: 'pending_verification', reason: 'name_mismatch' };
      }
    }
  }

  return { status: 'accepted' };
}

/**
 * Determine the effective status for a new observation when a previous
 * pending_verification observation exists.
 *
 * Two consecutive matching suspicious values → accept as new truth.
 * "Matching" means the new observation would ALSO be flagged as suspicious
 * against the same baseline.
 */
export function resolveWithPriorPending(
  newStatus: ObservationStatus,
  priorPendingStatus: ObservationStatus
): ObservationStatus {
  if (newStatus === 'pending_verification' && priorPendingStatus === 'pending_verification') {
    return 'accepted';
  }
  if (newStatus === 'accepted' && priorPendingStatus === 'pending_verification') {
    return 'accepted';
  }
  return newStatus;
}
