import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { resolveLocation, resolveLocationAsync, clearAsyncCache, findNearbyLocations, distanceBetween } from './geo.js';

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

  describe('resolveLocationAsync', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      clearAsyncCache();
      fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('resolves via GeoAdmin API', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{
            attrs: { lat: 47.4401, lon: 8.6259, label: '8303 - Bassersdorf' },
          }],
        }),
      });

      const result = await resolveLocationAsync('8303');
      expect(result).toEqual({ latitude: 47.4401, longitude: 8.6259 });
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy.mock.calls[0][0]).toContain('searchText=8303');
    });

    it('resolves city name via API', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{
            attrs: { lat: 47.4984, lon: 8.7291, label: 'Winterthur' },
          }],
        }),
      });

      const result = await resolveLocationAsync('Winterthur');
      expect(result).toEqual({ latitude: 47.4984, longitude: 8.7291 });
    });

    it('falls back to static DB on API failure', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('network error'));

      const result = await resolveLocationAsync('8001');
      expect(result).toEqual({ latitude: 47.3769, longitude: 8.5417 });
    });

    it('falls back to static DB on non-OK response', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await resolveLocationAsync('8001');
      expect(result).toEqual({ latitude: 47.3769, longitude: 8.5417 });
    });

    it('falls back to static DB on empty results', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      });

      const result = await resolveLocationAsync('0000');
      expect(result).toBeUndefined();
    });

    it('caches API results', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{
            attrs: { lat: 47.4401, lon: 8.6259, label: '8303' },
          }],
        }),
      });

      const first = await resolveLocationAsync('8303');
      const second = await resolveLocationAsync('8303');

      expect(first).toEqual(second);
      expect(fetchSpy).toHaveBeenCalledOnce();
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
