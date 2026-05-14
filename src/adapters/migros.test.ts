import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MigrosAdapter } from './migros.js';
import * as http from '../util/http.js';

vi.mock('../util/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../util/http.js')>();
  return { ...actual, fetchJson: vi.fn() };
});
const mockFetchJson = vi.mocked(http.fetchJson);

describe('MigrosAdapter', () => {
  let adapter: MigrosAdapter;

  beforeEach(() => {
    adapter = new MigrosAdapter();
    vi.resetAllMocks();
  });

  describe('chain identifier', () => {
    it('is migros', () => {
      expect(adapter.chain).toBe('migros');
    });
  });

  describe('searchProducts', () => {
    it('returns normalized products on success', async () => {
      mockFetchJson.mockResolvedValueOnce({
        products: [
          {
            id: 'prod-1',
            name: 'Bio Vollmilch',
            brand: 'Migros Bio',
            offer: { value: 1.65, display_value: 1.65, unit: 'L', display_unit: '1L' },
            categories: [{ name: 'Milchprodukte' }],
            quantity: '1L',
          },
        ],
        total_count: 1,
      });

      const result = await adapter.searchProducts({ query: 'milch', location: '' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toHaveLength(1);
      const product = result.data[0];
      expect(product.id).toBe('prod-1');
      expect(product.chain).toBe('migros');
      expect(product.name).toBe('Bio Vollmilch');
      expect(product.brand).toBe('Migros Bio');
      expect(product.price.current).toBe(1.65);
      expect(product.category).toBe('Milchprodukte');
    });

    it('filters out products with missing id or name', async () => {
      mockFetchJson.mockResolvedValueOnce({
        products: [
          { id: 'p1', name: 'Good Product' },
          { id: 'p2' },
          { name: 'No ID' },
        ],
      });

      const result = await adapter.searchProducts({ query: 'test', location: '' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('p1');
    });

    it('returns empty array when products field is missing', async () => {
      mockFetchJson.mockResolvedValueOnce({});

      const result = await adapter.searchProducts({ query: 'test', location: '' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toHaveLength(0);
    });

    it('returns error result on HTTP error', async () => {
      mockFetchJson.mockRejectedValueOnce(new http.HttpError(503, 'HTTP 503: Service Unavailable'));

      const result = await adapter.searchProducts({ query: 'milch', location: '' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('HTTP_503');
    });

    it('returns error result on network failure', async () => {
      mockFetchJson.mockRejectedValueOnce(new Error('Network timeout'));

      const result = await adapter.searchProducts({ query: 'milch', location: '' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('FETCH_ERROR');
      expect(result.error.message).toContain('Network timeout');
    });

    it('passes limit to URL', async () => {
      mockFetchJson.mockResolvedValueOnce({ products: [] });

      await adapter.searchProducts({ query: 'bread', limit: 5, location: '' });

      expect(mockFetchJson).toHaveBeenCalledWith(expect.stringContaining('limit=5'));
    });

    it('normalizes nutrition data when present', async () => {
      mockFetchJson.mockResolvedValueOnce({
        products: [
          {
            id: 'p1',
            name: 'Protein Bar',
            offer: { value: 2.5 },
            nutritional_values: {
              energy_kcal: 450,
              proteins: 20,
              carbohydrates: 45,
              fat: 15,
              fiber: 5,
              sugar: 10,
            },
          },
        ],
      });

      const result = await adapter.searchProducts({ query: 'protein', location: '' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const nutrition = result.data[0].nutrition;
      expect(nutrition?.energyKcal).toBe(450);
      expect(nutrition?.protein).toBe(20);
      expect(nutrition?.carbs).toBe(45);
    });
  });

  describe('findStores', () => {
    it('returns normalized stores on success', async () => {
      mockFetchJson.mockResolvedValueOnce({
        stores: [
          {
            id: 'store-1',
            name: 'Migros Zürich HB',
            address: { street: 'Bahnhofquai 15', zip: '8001', city: 'Zürich' },
            geo: { lat: 47.3778, lng: 8.5391 },
            opening_hours: { text: 'Mo-Sa 06:30-22:00' },
          },
        ],
      });

      const result = await adapter.findStores({ location: '8001' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toHaveLength(1);
      const store = result.data[0];
      expect(store.id).toBe('store-1');
      expect(store.chain).toBe('migros');
      expect(store.name).toBe('Migros Zürich HB');
      expect(store.location.latitude).toBe(47.3778);
      expect(store.location.longitude).toBe(8.5391);
      expect(store.openingHours).toBe('Mo-Sa 06:30-22:00');
    });

    it('filters stores without geo coordinates', async () => {
      mockFetchJson.mockResolvedValueOnce({
        stores: [
          { id: 's1', name: 'Valid', address: {}, geo: { lat: 46.9, lng: 7.4 } },
          { id: 's2', name: 'No geo', address: {} },
        ],
      });

      const result = await adapter.findStores({ location: 'Bern' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toHaveLength(1);
    });

    it('returns error on HTTP failure', async () => {
      mockFetchJson.mockRejectedValueOnce(new http.HttpError(404, 'HTTP 404: Not Found'));

      const result = await adapter.findStores({ location: '9999' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('HTTP_404');
    });
  });

  describe('getStoreAvailabilitySupport', () => {
    it('returns chain migros and supported false for HTTP adapter', () => {
      const support = adapter.getStoreAvailabilitySupport();
      expect(support.chain).toBe('migros');
      expect(support.supported).toBe(false);
    });
  });

  describe('lookupStoreProductAvailability', () => {
    it('returns not-supported result', async () => {
      const result = await adapter.lookupStoreProductAvailability({ storeId: 's1', query: 'milk' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.supported).toBe(false);
      expect(result.data.isAvailable).toBe(false);
    });
  });
});
