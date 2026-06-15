import { Chain } from '../adapters/types.js';

export interface ObservedStoreRecord {
  id: string;
  chain: Chain;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  openingHours?: string;
  sourceUrl?: string;
  observedAt: string;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const earthRadiusKm = 6371;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function filterByRadius(
  stores: ObservedStoreRecord[],
  center: GeoPoint,
  radiusKm: number
): ObservedStoreRecord[] {
  return stores.filter(
    (store) =>
      distanceKm({ latitude: store.latitude, longitude: store.longitude }, center) <= radiusKm
  );
}

export function sortByDistance(
  stores: ObservedStoreRecord[],
  center: GeoPoint
): ObservedStoreRecord[] {
  return [...stores].sort(
    (a, b) =>
      distanceKm({ latitude: a.latitude, longitude: a.longitude }, center) -
      distanceKm({ latitude: b.latitude, longitude: b.longitude }, center)
  );
}
