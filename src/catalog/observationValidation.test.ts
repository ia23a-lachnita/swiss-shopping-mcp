import { describe, it, expect } from 'vitest';
import {
  validateObservation,
  resolveWithPriorPending,
  type CredibleBaseline,
} from './observationValidation.js';

describe('validateObservation', () => {
  describe('zero or negative price', () => {
    it('should flag zero price', () => {
      const result = validateObservation(
        { price: 0, promotionPrice: null, currency: 'CHF', size: null, name: 'Milk' },
        undefined
      );
      expect(result.status).toBe('pending_verification');
      expect(result.reason).toBe('zero_or_negative_price');
    });

    it('should flag negative price', () => {
      const result = validateObservation(
        { price: -5, promotionPrice: null, currency: 'CHF', size: null, name: 'Milk' },
        undefined
      );
      expect(result.status).toBe('pending_verification');
      expect(result.reason).toBe('zero_or_negative_price');
    });
  });

  describe('missing currency', () => {
    it('should flag when price present but currency missing', () => {
      const result = validateObservation(
        { price: 3.50, promotionPrice: null, currency: null, size: null, name: 'Milk' },
        undefined
      );
      expect(result.status).toBe('pending_verification');
      expect(result.reason).toBe('missing_currency');
    });

    it('should accept when price is null and currency is null', () => {
      const result = validateObservation(
        { price: null, promotionPrice: null, currency: null, size: null, name: 'Milk' },
        undefined
      );
      expect(result.status).toBe('accepted');
    });
  });

  describe('normal price drop > 75%', () => {
    it('should flag 80% drop in normal price', () => {
      const baseline: CredibleBaseline = {
        price: 10,
        promotionPrice: null,
        currency: 'CHF',
        size: null,
        name: 'Milk',
        status: 'accepted',
      };
      const result = validateObservation(
        { price: 2, promotionPrice: null, currency: 'CHF', size: null, name: 'Milk' },
        baseline
      );
      expect(result.status).toBe('pending_verification');
      expect(result.reason).toContain('price_drop');
    });

    it('should retain credible value (baseline unchanged)', () => {
      const baseline: CredibleBaseline = {
        price: 10,
        promotionPrice: null,
        currency: 'CHF',
        size: null,
        name: 'Milk',
        status: 'accepted',
      };
      const result = validateObservation(
        { price: 2, promotionPrice: null, currency: 'CHF', size: null, name: 'Milk' },
        baseline
      );
      // The result says pending — the caller should NOT overwrite the baseline
      expect(result.status).toBe('pending_verification');
      // The baseline price is still 10 (not replaced)
      expect(baseline.price).toBe(10);
    });

    it('should accept a 70% drop (within threshold)', () => {
      const baseline: CredibleBaseline = {
        price: 10,
        promotionPrice: null,
        currency: 'CHF',
        size: null,
        name: 'Milk',
        status: 'accepted',
      };
      const result = validateObservation(
        { price: 3, promotionPrice: null, currency: 'CHF', size: null, name: 'Milk' },
        baseline
      );
      expect(result.status).toBe('accepted');
    });
  });

  describe('normal price spike > 100%', () => {
    it('should flag 200% spike in normal price', () => {
      const baseline: CredibleBaseline = {
        price: 5,
        promotionPrice: null,
        currency: 'CHF',
        size: null,
        name: 'Milk',
        status: 'accepted',
      };
      const result = validateObservation(
        { price: 15, promotionPrice: null, currency: 'CHF', size: null, name: 'Milk' },
        baseline
      );
      expect(result.status).toBe('pending_verification');
      expect(result.reason).toContain('price_spike');
    });
  });

  describe('legit 50% promo (promotion_price field)', () => {
    it('should NOT flag a 50% promo in promotion_price field', () => {
      const baseline: CredibleBaseline = {
        price: 10,
        promotionPrice: null,
        currency: 'CHF',
        size: null,
        name: 'Milk',
        status: 'accepted',
      };
      const result = validateObservation(
        { price: 10, promotionPrice: 5, currency: 'CHF', size: null, name: 'Milk' },
        baseline
      );
      // promotion_price=5, normal price=10 → 5 < 10 → NOT flagged
      expect(result.status).toBe('accepted');
    });

    it('should NOT apply 75%-drop rule to promotion_price', () => {
      const baseline: CredibleBaseline = {
        price: 10,
        promotionPrice: 10,
        currency: 'CHF',
        size: null,
        name: 'Milk',
        status: 'accepted',
      };
      // New observation: normal price stays 10, promotion_price = 3 (70% off normal)
      // The 75%-drop rule only applies to NORMAL price, not promotion_price
      const result = validateObservation(
        { price: 10, promotionPrice: 3, currency: 'CHF', size: null, name: 'Milk' },
        baseline
      );
      expect(result.status).toBe('accepted');
    });
  });

  describe('promo > normal price', () => {
    it('should flag when promotion_price exceeds normal price', () => {
      const baseline: CredibleBaseline = {
        price: 10,
        promotionPrice: null,
        currency: 'CHF',
        size: null,
        name: 'Milk',
        status: 'accepted',
      };
      const result = validateObservation(
        { price: 8, promotionPrice: 12, currency: 'CHF', size: null, name: 'Milk' },
        baseline
      );
      expect(result.status).toBe('pending_verification');
      expect(result.reason).toBe('promo_exceeds_normal');
    });
  });

  describe('package-size change', () => {
    it('should flag size change on same product', () => {
      const baseline: CredibleBaseline = {
        price: 2,
        promotionPrice: null,
        currency: 'CHF',
        size: '500g',
        name: 'Milk',
        status: 'accepted',
      };
      const result = validateObservation(
        { price: 2, promotionPrice: null, currency: 'CHF', size: '1l', name: 'Milk' },
        baseline
      );
      expect(result.status).toBe('pending_verification');
      expect(result.reason).toBe('size_changed');
    });
  });

  describe('product-name mismatch', () => {
    it('should flag name mismatch with low similarity', () => {
      const baseline: CredibleBaseline = {
        price: 2,
        promotionPrice: null,
        currency: 'CHF',
        size: null,
        name: 'Vollmilch 1L Migros',
        status: 'accepted',
      };
      const result = validateObservation(
        { price: 2, promotionPrice: null, currency: 'CHF', size: null, name: 'Schokoladenpudding' },
        baseline
      );
      expect(result.status).toBe('pending_verification');
      expect(result.reason).toBe('name_mismatch');
    });

    it('should accept similar names', () => {
      const baseline: CredibleBaseline = {
        price: 2,
        promotionPrice: null,
        currency: 'CHF',
        size: null,
        name: 'Migros Vollmilch 1L',
        status: 'accepted',
      };
      const result = validateObservation(
        { price: 2, promotionPrice: null, currency: 'CHF', size: null, name: 'Migros Vollmilch 1 l' },
        baseline
      );
      expect(result.status).toBe('accepted');
    });
  });

  describe('no baseline', () => {
    it('should accept when no baseline exists', () => {
      const result = validateObservation(
        { price: 5, promotionPrice: null, currency: 'CHF', size: null, name: 'Milk' },
        undefined
      );
      expect(result.status).toBe('accepted');
    });
  });
});

describe('resolveWithPriorPending', () => {
  it('should accept when both are pending_verification', () => {
    const result = resolveWithPriorPending('pending_verification', 'pending_verification');
    expect(result).toBe('accepted');
  });

  it('should accept when new is accepted and prior was pending', () => {
    const result = resolveWithPriorPending('accepted', 'pending_verification');
    expect(result).toBe('accepted');
  });

  it('should keep pending when new is pending and prior was accepted', () => {
    const result = resolveWithPriorPending('pending_verification', 'accepted');
    expect(result).toBe('pending_verification');
  });

  it('should keep accepted when both are accepted', () => {
    const result = resolveWithPriorPending('accepted', 'accepted');
    expect(result).toBe('accepted');
  });
});
