import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Locate } from 'lucide-react';

import type { StoreWithAvailability } from '../api';
import { mapsUrl } from '../lib/utils';
import { cn } from '../lib/utils';

type MapMode = 'street' | 'satellite';

function styleFor(mode: MapMode): maplibregl.StyleSpecification {
  return mode === 'street'
    ? {
        version: 8,
        sources: {
          street: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap',
          },
        },
        layers: [{ id: 'street', type: 'raster', source: 'street' }],
      }
    : {
        // Switzerland's own official aerial imagery — free, no API key.
        version: 8,
        sources: {
          satellite: {
            type: 'raster',
            tiles: [
              'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg',
            ],
            tileSize: 256,
            attribution: '© swisstopo',
          },
        },
        layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }],
      };
}

/**
 * Per-product store map — scoped to exactly one product's own stores (opened
 * from that product's card), not a shared map across every matched product.
 * Uses MapLibre GL directly: native two-finger rotate/pitch, and a
 * street/satellite toggle (dark-mode tile inversion only applies to the
 * street line-art layer — never to real aerial photography).
 */
export function ProductMap({
  stores,
  userCoords,
}: {
  stores: StoreWithAvailability[];
  userCoords?: { lat: number; lng: number };
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | undefined>(undefined);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const boundsRef = useRef<maplibregl.LngLatBounds | undefined>(undefined);
  const [mode, setMode] = useState<MapMode>('street');

  useEffect(() => {
    if (!containerRef.current || stores.length === 0) return;

    const points: [number, number][] = stores.map((s) => [s.location.longitude, s.location.latitude]);
    if (userCoords) points.push([userCoords.lng, userCoords.lat]);
    const bounds = points.slice(1).reduce(
      (b, p) => b.extend(p),
      new maplibregl.LngLatBounds(points[0], points[0])
    );
    boundsRef.current = bounds;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleFor('street'),
      bounds,
      fitBoundsOptions: { padding: 48, maxZoom: 16 },
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-left');
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stores]);

  function recenter(): void {
    if (mapRef.current && boundsRef.current) {
      mapRef.current.fitBounds(boundsRef.current, { padding: 48, maxZoom: 16 });
    }
  }

  useEffect(() => {
    mapRef.current?.setStyle(styleFor(mode));
  }, [mode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const m of markersRef.current) m.remove();
    markersRef.current = [];

    for (const store of stores) {
      const el = document.createElement('div');
      el.style.cssText = `width:14px;height:14px;border-radius:9999px;background:${
        store.available ? '#3f7a4e' : '#a8442f'
      };border:2px solid var(--color-surface);box-shadow:0 1px 3px rgba(0,0,0,0.4)`;
      const popup = new maplibregl.Popup({ offset: 12, closeButton: false }).setHTML(
        `<div style="min-width:160px;font:13px system-ui;color:#201f1c">
          <p style="margin:0;font-weight:600">${store.name}</p>
          <p style="margin:2px 0 6px;font-size:11px;color:#8a867d">${store.address}</p>
          <a href="${mapsUrl(store.location.latitude, store.location.longitude)}" target="_blank" rel="noreferrer" style="font-size:11px;font-weight:600;color:#8f7320">Route öffnen ↗</a>
        </div>`
      );
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([store.location.longitude, store.location.latitude])
        .setPopup(popup)
        .addTo(map);
      markersRef.current.push(marker);
    }

    if (userCoords) {
      const el = document.createElement('div');
      el.style.cssText =
        'width:16px;height:16px;border-radius:9999px;background:#8f7320;border:2px solid white;box-shadow:0 0 0 6px rgba(143,115,32,0.25)';
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([userCoords.lng, userCoords.lat])
        .addTo(map);
      markersRef.current.push(marker);
    }
  }, [stores, userCoords, mode]);

  return (
    <div className="relative h-56 w-full overflow-hidden rounded-card shadow-card">
      <div
        ref={containerRef}
        // touch-none: without this, a touch-drag starting on the map canvas can be
        // interpreted by the browser as a page/drawer scroll gesture before MapLibre's
        // own pan handler claims it — the map would then fight the sheet for the
        // gesture instead of owning it outright.
        className={cn(
          'h-full w-full touch-none',
          mode === 'street' && '[&_.maplibregl-canvas]:dark:invert [&_.maplibregl-canvas]:dark:hue-rotate-180 [&_.maplibregl-canvas]:dark:brightness-75 [&_.maplibregl-canvas]:dark:contrast-90'
        )}
      />
      <div className="absolute right-2 top-2 z-10 flex gap-0.5 rounded-full bg-surface p-1 text-xs font-bold shadow-inset">
        <button
          type="button"
          onClick={() => setMode('street')}
          className={cn('rounded-full px-2.5 py-1', mode === 'street' ? 'bg-brand text-brand-ink' : 'text-faint')}
        >
          Strasse
        </button>
        <button
          type="button"
          onClick={() => setMode('satellite')}
          className={cn('rounded-full px-2.5 py-1', mode === 'satellite' ? 'bg-brand text-brand-ink' : 'text-faint')}
        >
          Satellit
        </button>
      </div>
      <button
        type="button"
        onClick={recenter}
        aria-label="Auf Filialen zentrieren"
        className="absolute bottom-2 right-2 z-10 flex size-8 items-center justify-center rounded-full bg-surface text-ink shadow-inset"
      >
        <Locate className="size-4" />
      </button>
    </div>
  );
}
