import { describe, expect, it } from 'vitest';

import {
  distanceKm,
  filterByRadius,
  GeoPoint,
  ObservedStoreRecord,
  sortByDistance,
} from './storeSource.js';

function store(id: string, lat: number, lon: number): ObservedStoreRecord {
  return {
    id,
    chain: 'aldi',
    name: id,
    address: 'Test address',
    latitude: lat,
    longitude: lon,
    observedAt: new Date().toISOString(),
  };
}

const ZURICH: GeoPoint = { latitude: 47.3769, longitude: 8.5417 };
const BERN: GeoPoint = { latitude: 46.9481, longitude: 7.4474 };

describe('distanceKm', () => {
  it('returns 0 for the same point', () => {
    expect(distanceKm(ZURICH, ZURICH)).toBeCloseTo(0);
  });

  it('computes approximate Zurich–Bern distance (~95 km)', () => {
    expect(distanceKm(ZURICH, BERN)).toBeGreaterThan(90);
    expect(distanceKm(ZURICH, BERN)).toBeLessThan(100);
  });

  it('is symmetric', () => {
    expect(distanceKm(ZURICH, BERN)).toBeCloseTo(distanceKm(BERN, ZURICH));
  });
});

describe('filterByRadius', () => {
  const nearZurich = store('near', 47.38, 8.55);
  const farFromZurich = store('far', 46.95, 7.45);

  it('includes stores within radius', () => {
    const result = filterByRadius([nearZurich, farFromZurich], ZURICH, 10);
    expect(result.map((s) => s.id)).toEqual(['near']);
  });

  it('includes stores exactly at boundary', () => {
    const distance = distanceKm(
      { latitude: nearZurich.latitude, longitude: nearZurich.longitude },
      ZURICH
    );
    const result = filterByRadius([nearZurich], ZURICH, distance);
    expect(result).toHaveLength(1);
  });

  it('excludes stores outside radius', () => {
    const result = filterByRadius([nearZurich, farFromZurich], ZURICH, 5);
    expect(result.some((s) => s.id === 'far')).toBe(false);
  });
});

describe('sortByDistance', () => {
  const close = store('close', 47.38, 8.55);
  const medium = store('medium', 47.20, 8.60);
  const far = store('far', 46.95, 7.45);

  it('sorts stores by ascending distance from center', () => {
    const result = sortByDistance([far, close, medium], ZURICH);
    expect(result.map((s) => s.id)).toEqual(['close', 'medium', 'far']);
  });

  it('does not mutate the original array', () => {
    const original = [far, close];
    sortByDistance(original, ZURICH);
    expect(original[0].id).toBe('far');
  });
});
