import { useEffect, useMemo } from 'react';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import type { Product, StoreWithAvailability } from '../api';
import { formatPrice, mapsUrl } from '../lib/utils';

interface MapStore {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  items: Array<{ product: Product; store: StoreWithAvailability }>;
}

function statusColor(items: MapStore['items']): string {
  if (items.some(({ store }) => store.available)) return '#059669';
  if (items.every(({ store }) => store.availabilitySupported === false)) return '#a1a1aa';
  return '#dc2626';
}

function pinIcon(color: string): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<span style="display:block;width:14px;height:14px;border-radius:9999px;background:${color};border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,0.4)"></span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

const userIcon = L.divIcon({
  className: '',
  html: '<span style="display:block;width:16px;height:16px;border-radius:9999px;background:#2563eb;border:2px solid white;box-shadow:0 0 0 6px rgba(37,99,235,0.25)"></span>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

/** Leaflet caches container size at init; a map shown after being CSS-hidden
 * (display:none while another view was active) needs an explicit recalculation
 * or it renders with stale/blank tiles. */
function InvalidateSizeOnShow({ active }: { active: boolean }): null {
  const map = useMap();
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => map.invalidateSize());
    return () => cancelAnimationFrame(id);
  }, [active, map]);
  return null;
}

export function AvailabilityMap({
  results,
  userCoords,
  active,
}: {
  results: Array<{ product: Product; stores: StoreWithAvailability[] }>;
  userCoords?: { lat: number; lng: number };
  active: boolean;
}): React.JSX.Element {
  const stores = useMemo(() => {
    const byId = new Map<string, MapStore>();
    for (const { product, stores: productStores } of results) {
      for (const store of productStores) {
        const entry = byId.get(store.id) ?? {
          id: store.id,
          name: store.name,
          address: store.address,
          lat: store.location.latitude,
          lng: store.location.longitude,
          items: [],
        };
        entry.items.push({ product, store });
        byId.set(store.id, entry);
      }
    }
    return [...byId.values()];
  }, [results]);

  const center: [number, number] = userCoords
    ? [userCoords.lat, userCoords.lng]
    : stores.length > 0
      ? [stores[0].lat, stores[0].lng]
      : [47.3769, 8.5417];

  return (
    <div className="h-[65vh] w-full overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800 [&_.leaflet-tile-pane]:dark:brightness-75 [&_.leaflet-tile-pane]:dark:contrast-90 [&_.leaflet-tile-pane]:dark:invert [&_.leaflet-tile-pane]:dark:hue-rotate-180">
      <MapContainer center={center} zoom={13} scrollWheelZoom className="h-full w-full" data-testid="availability-map">
        <InvalidateSizeOnShow active={active} />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {userCoords && (
          <Marker position={[userCoords.lat, userCoords.lng]} icon={userIcon}>
            <Popup>Dein Standort</Popup>
          </Marker>
        )}
        {stores.map((store) => (
          <Marker key={store.id} position={[store.lat, store.lng]} icon={pinIcon(statusColor(store.items))}>
            <Popup>
              <div className="min-w-[180px] space-y-1.5">
                <p className="font-medium text-zinc-900">{store.name}</p>
                <p className="text-xs text-zinc-500">{store.address}</p>
                <ul className="space-y-1 pt-1">
                  {store.items.map(({ product, store: s }) => (
                    <li
                      key={`${product.chain}:${product.id}`}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="truncate">{product.name}</span>
                      <span
                        className="shrink-0 font-medium"
                        style={{ color: s.available ? '#059669' : '#dc2626' }}
                      >
                        {s.available ? formatPrice(product.price.current) : 'Nicht verfügbar'}
                      </span>
                    </li>
                  ))}
                </ul>
                <a
                  href={mapsUrl(store.lat, store.lng)}
                  target="_blank"
                  rel="noreferrer"
                  className="block pt-1 text-xs font-medium text-blue-600"
                >
                  Route öffnen ↗
                </a>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
