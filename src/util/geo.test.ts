import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { resolveLocation, resolveLocationAsync, clearAsyncCache, findNearbyLocations, distanceBetween, reverseGeocode, reverseGeocodeAsync, suggestLocationsAsync } from './geo.js';

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

  describe('suggestLocationsAsync', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('normalizes zipcode-origin labels to "<zip> <city>"', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            { attrs: { label: '<b>8001 - Zürich</b>', lat: 47.37, lon: 8.54, origin: 'zipcode' } },
          ],
        }),
      });

      const results = await suggestLocationsAsync('800');
      expect(results).toEqual([{ label: '8001 Zürich', latitude: 47.37, longitude: 8.54 }]);
    });

    it('strips the trailing canton suffix from gg25-origin place-name labels', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            { attrs: { label: '<b>Winterthur (ZH)</b>', lat: 47.5, lon: 8.72, origin: 'gg25' } },
          ],
        }),
      });

      const results = await suggestLocationsAsync('wint');
      expect(results).toEqual([{ label: 'Winterthur', latitude: 47.5, longitude: 8.72 }]);
    });

    it('deduplicates identical labels across results', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            { attrs: { label: '<b>Winterthur (ZH)</b>', lat: 47.5, lon: 8.72, origin: 'gg25' } },
            { attrs: { label: '<b>Winterthur (ZH)</b>', lat: 47.5, lon: 8.72, origin: 'gg25' } },
          ],
        }),
      });

      const results = await suggestLocationsAsync('wint');
      expect(results).toHaveLength(1);
    });

    it('returns empty array below the minimum length without calling fetch', async () => {
      const results = await suggestLocationsAsync('w');
      expect(results).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns empty array when the API call fails', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('network down'));
      const results = await suggestLocationsAsync('wint');
      expect(results).toEqual([]);
    });

    it('returns empty array on a non-ok response', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false });
      const results = await suggestLocationsAsync('wint');
      expect(results).toEqual([]);
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

  describe('reverseGeocode', () => {
    it('maps coordinates to the nearest known locality as a usable location string', () => {
      const result = reverseGeocode({ latitude: 47.3769, longitude: 8.5417 });

      expect(result).toBeDefined();
      expect(result!.city).toBe('Zürich');
      expect(result!.location).toMatch(/^\d{4} Zürich$/);
      expect(result!.distanceKm).toBeLessThan(1);
    });

    it('returns undefined for coordinates far outside Switzerland', () => {
      // Berlin is well beyond the 30 km default radius of any Swiss locality.
      expect(reverseGeocode({ latitude: 52.52, longitude: 13.405 })).toBeUndefined();
    });
  });

  describe('reverseGeocodeAsync', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('resolves via the GeoAdmin PLZ registry', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{ properties: { plz: 8055, langtext: 'Zürich' } }],
        }),
      });

      const result = await reverseGeocodeAsync({ latitude: 47.3665, longitude: 8.5088 });
      expect(result).toEqual({ zip: '8055', city: 'Zürich', location: '8055 Zürich', distanceKm: 0 });
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('falls back to the static DB on API failure', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('network error'));

      const result = await reverseGeocodeAsync({ latitude: 47.3769, longitude: 8.5417 });
      expect(result).toBeDefined();
      expect(result!.city).toBe('Zürich');
    });

    it('falls back to the static DB on non-OK response', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await reverseGeocodeAsync({ latitude: 47.3769, longitude: 8.5417 });
      expect(result).toBeDefined();
      expect(result!.city).toBe('Zürich');
    });

    it('falls back to the static DB on empty results', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      });

      const result = await reverseGeocodeAsync({ latitude: 47.3769, longitude: 8.5417 });
      expect(result).toBeDefined();
      expect(result!.city).toBe('Zürich');
    });
  });
});
