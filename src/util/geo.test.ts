import { describe, expect, it } from 'vitest';

import { resolveLocation, findNearbyLocations, distanceBetween } from './geo.js';

describe('geo utility', () => {
  describe('resolveLocation', () => {
    it('resolves a pure ZIP code to coordinates', () => {
      const result = resolveLocation('8001');
      expect(result).toEqual({ latitude: 47.3769, longitude: 8.5417 });
    });

    it('resolves ZIP + city to coordinates', () => {
      const result = resolveLocation('3000 Bern');
      expect(result).toEqual({ latitude: 46.9480, longitude: 7.4474 });
    });

    it('resolves city name to coordinates', () => {
      const result = resolveLocation('Zürich');
      expect(result).toBeDefined();
      expect(result!.latitude).toBeCloseTo(47.3769, 2);
    });

    it('returns undefined for unknown ZIP', () => {
      const result = resolveLocation('0000');
      expect(result).toBeUndefined();
    });

    it('returns undefined for unknown city', () => {
      const result = resolveLocation('Atlantis');
      expect(result).toBeUndefined();
    });

    it('resolves Basel correctly', () => {
      const result = resolveLocation('4000');
      expect(result).toEqual({ latitude: 47.5596, longitude: 7.5886 });
    });
  });

  describe('findNearbyLocations', () => {
    it('finds locations within radius', () => {
      const center = { latitude: 47.3769, longitude: 8.5417 }; // Zürich
      const nearby = findNearbyLocations(center, 50);

      expect(nearby.length).toBeGreaterThan(0);
      expect(nearby.every((item) => item.distance <= 50)).toBe(true);
    });

    it('returns sorted by distance', () => {
      const center = { latitude: 47.3769, longitude: 8.5417 };
      const nearby = findNearbyLocations(center, 100);

      for (let i = 1; i < nearby.length; i++) {
        expect(nearby[i].distance).toBeGreaterThanOrEqual(nearby[i - 1].distance);
      }
    });
  });

  describe('distanceBetween', () => {
    it('calculates distance between two points', () => {
      const zurich = { latitude: 47.3769, longitude: 8.5417 };
      const bern = { latitude: 46.9480, longitude: 7.4474 };
      const dist = distanceBetween(zurich, bern);

      expect(dist).toBeGreaterThan(80);
      expect(dist).toBeLessThan(120);
    });

    it('returns 0 for same point', () => {
      const point = { latitude: 47.3769, longitude: 8.5417 };
      expect(distanceBetween(point, point)).toBe(0);
    });
  });
});
