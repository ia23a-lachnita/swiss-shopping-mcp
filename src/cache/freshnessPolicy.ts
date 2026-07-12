/**
 * Central freshness policy: named volatility tiers with soft/hard/stale durations.
 *
 * Call sites request a tier by name rather than specifying raw milliseconds.
 * Each tier defines three phases:
 *   - soft TTL:  data is fresh; no refresh needed.
 *   - hard TTL:  data is usable but caller may refresh opportunistically.
 *   - stale window: data must NOT be returned directly; caller must try a
 *     refresh and may only fall back to the stale value on provider failure.
 */

export interface FreshnessTier {
  /** Display name for debugging / provenance. */
  readonly name: string;
  /** Soft TTL in ms — data is fresh until this point. */
  readonly softMs: number;
  /** Hard TTL in ms — data expires at observedAt + hardMs. */
  readonly hardMs: number;
  /** Stale fallback window in ms (absolute, from observedAt). 0 = no stale fallback. */
  readonly staleMs: number;
}

function hours(n: number): number {
  return n * 60 * 60 * 1_000;
}

function days(n: number): number {
  return n * 24 * hours(1);
}

function minutes(n: number): number {
  return n * 60 * 1_000;
}

/** Query → product-ID mappings (web search discovery). */
export const DISCOVERY: FreshnessTier = {
  name: 'discovery',
  softMs: days(7),
  hardMs: days(30),
  staleMs: days(90),
};

/** Product metadata (name, brand, size, category). */
export const PRODUCT_METADATA: FreshnessTier = {
  name: 'productMetadata',
  softMs: days(7),
  hardMs: days(30),
  staleMs: 0,
};

/** Product existence check. */
export const EXISTENCE: FreshnessTier = {
  name: 'existence',
  softMs: days(1),
  hardMs: days(7),
  staleMs: 0,
};

/** Normal (non-promotional) price. */
export const NORMAL_PRICE: FreshnessTier = {
  name: 'normalPrice',
  softMs: hours(1),
  hardMs: hours(6),
  staleMs: 0,
};

/** Promotional price. */
export const PROMO_PRICE: FreshnessTier = {
  name: 'promoPrice',
  softMs: hours(1),
  hardMs: hours(3),
  staleMs: 0,
};

/** Store-level availability / stock. */
export const AVAILABILITY: FreshnessTier = {
  name: 'availability',
  softMs: minutes(5),
  hardMs: minutes(15),
  staleMs: 0,
};

/** Confirmed zero-result search (negative cache). */
export const EMPTY_SEARCH: FreshnessTier = {
  name: 'emptySearch',
  softMs: minutes(5),
  hardMs: minutes(15),
  staleMs: 0,
};

/**
 * All named tiers keyed by name for programmatic lookup.
 */
export const TIERS: ReadonlyMap<string, FreshnessTier> = new Map(
  [DISCOVERY, PRODUCT_METADATA, EXISTENCE, NORMAL_PRICE, PROMO_PRICE, AVAILABILITY, EMPTY_SEARCH].map(
    (tier) => [tier.name, tier],
  ),
);

/**
 * Compute TTL boundaries from a tier and an observation timestamp.
 */
export function computeTtlBoundaries(
  tier: FreshnessTier,
  observedAt: Date,
): { refreshAfter: Date; expiresAt: Date; staleUntil: Date } {
  const observedMs = observedAt.getTime();
  return {
    refreshAfter: new Date(observedMs + tier.softMs),
    expiresAt: new Date(observedMs + tier.hardMs),
    staleUntil: tier.staleMs > 0 ? new Date(observedMs + tier.staleMs) : new Date(observedMs + tier.hardMs),
  };
}
