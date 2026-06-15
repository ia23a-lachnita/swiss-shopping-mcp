import { describe, expect, it } from 'vitest';

import { ALL_CHAINS } from './index.js';
import { getAllCapabilityStatuses, getCapabilityStatuses } from './sourceRegistry.js';

describe('sourceRegistry', () => {
  it('has status entries for every chain', () => {
    for (const chain of ALL_CHAINS) {
      expect(getCapabilityStatuses(chain).length).toBeGreaterThan(0);
    }
  });

  it('has all 5 capabilities registered for every chain', () => {
    const expectedCapabilities = new Set([
      'productSearch',
      'promotions',
      'storeSearch',
      'availability',
      'nutrition',
    ]);

    for (const chain of ALL_CHAINS) {
      const statuses = getCapabilityStatuses(chain);
      const capabilities = new Set(statuses.map((s) => s.capability));
      for (const cap of expectedCapabilities) {
        expect(capabilities.has(cap as never), `${chain} missing capability: ${cap}`).toBe(true);
      }
    }
  });

  it('returns live-beta for aldi productSearch', () => {
    const statuses = getCapabilityStatuses('aldi');
    const productSearch = statuses.find((s) => s.capability === 'productSearch');
    expect(productSearch?.status).toBe('live-beta');
  });

  it('returns live-beta for denner promotions', () => {
    const statuses = getCapabilityStatuses('denner');
    const promotions = statuses.find((s) => s.capability === 'promotions');
    expect(promotions?.status).toBe('live-beta');
  });

  it('returns blocked for farmy all capabilities', () => {
    const statuses = getCapabilityStatuses('farmy');
    expect(statuses.every((s) => s.status === 'blocked')).toBe(true);
  });

  it('returns blocked for migros productSearch', () => {
    const statuses = getCapabilityStatuses('migros');
    const productSearch = statuses.find((s) => s.capability === 'productSearch');
    expect(productSearch?.status).toBe('blocked');
  });

  it('filters by capability', () => {
    const statuses = getCapabilityStatuses('aldi', ['productSearch', 'promotions']);
    expect(statuses).toHaveLength(2);
    expect(statuses.map((s) => s.capability).sort()).toEqual(['productSearch', 'promotions']);
  });

  it('getAllCapabilityStatuses returns all chains when no filter given', () => {
    const statuses = getAllCapabilityStatuses();
    expect(statuses.length).toBe(ALL_CHAINS.length * 5);
  });

  it('getAllCapabilityStatuses filters by chain', () => {
    const statuses = getAllCapabilityStatuses(['aldi', 'denner']);
    expect(statuses.every((s) => ['aldi', 'denner'].includes(s.chain))).toBe(true);
    expect(statuses.length).toBe(10);
  });

  it('getAllCapabilityStatuses filters by capability', () => {
    const statuses = getAllCapabilityStatuses(undefined, ['productSearch']);
    expect(statuses.every((s) => s.capability === 'productSearch')).toBe(true);
    expect(statuses.length).toBe(ALL_CHAINS.length);
  });
});
