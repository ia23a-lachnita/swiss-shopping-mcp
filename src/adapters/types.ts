export type Chain = 'migros' | 'coop' | 'aldi' | 'denner' | 'lidl' | 'farmy' | 'volg' | 'ottos';

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface NormalizedPrice {
  current: number;
  original?: number;
  unit?: {
    value: number;
    per: string; // e.g., "100g", "1l", "piece"
  };
}

export interface NormalizedProduct {
  id: string;
  chain: Chain;
  name: string;
  brand?: string;
  price: NormalizedPrice;
  category?: string;
  size?: string;
  image?: string;
  tags?: string[]; // e.g., "organic", "vegan", "budget"
  nutrition?: {
    energyKcal?: number;
    protein?: number;
    carbs?: number;
    fat?: number;
    fiber?: number;
    sugar?: number;
  };
  allergens?: string[];
}

export interface NormalizedStore {
  id: string;
  chain: Chain;
  name: string;
  address: string;
  location: GeoPoint;
  openingHours?: string;
}

export interface NormalizedPromotion {
  id: string;
  chain: Chain;
  title: string;
  discount?: {
    type: 'percentage' | 'absolute';
    value: number;
  };
  validFrom: Date;
  validUntil: Date;
  applicableStores?: string[];
}

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message?: string } };
