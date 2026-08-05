import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Locate, Maximize2, Minimize2 } from 'lucide-react';

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
          labels: {
            type: 'raster',
            tiles: [
              'https://a.basemaps.cartocdn.com/rastertiles/dark_only_labels/{z}/{x}/{y}@2x.png',
              'https://b.basemaps.cartocdn.com/rastertiles/dark_only_labels/{z}/{x}/{y}@2x.png',
              'https://c.basemaps.cartocdn.com/rastertiles/dark_only_labels/{z}/{x}/{y}@2x.png',
            ],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors © CARTO',
          },
        },
        // Aerial imagery carries no place names at all, which leaves the user
        // with photography they cannot orient in — reported from a real phone.
        // A labels-only raster composited on top is the fix; CARTO's
        // `dark_only_labels` is the variant drawn FOR dark basemaps, so its
        // text is light with a dark halo and stays legible over fields, roofs
        // and water alike. (`light_only_labels` is the inverse — dark text for
        // pale basemaps — and disappears into shadow over aerial.)
        layers: [
          { id: 'satellite', type: 'raster', source: 'satellite' },
          { id: 'satellite-labels', type: 'raster', source: 'labels' },
        ],
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
  const [fullscreen, setFullscreen] = useState(false);

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
      // The map sits inside a scrollable bottom sheet, and it used to own every
      // touch (the container carried `touch-none`), so a drag that started on
      // the map could never scroll the sheet past it. Cooperative gestures
      // invert that: one finger belongs to the sheet, two fingers pan and zoom
      // the map. Fullscreen turns it off again, where one finger should pan
      // because there is nothing behind the map to scroll.
      cooperativeGestures: true,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-left');
    // Tapping the map itself opens fullscreen. Marker taps do not reach here —
    // markers are their own DOM elements, so their clicks still open the popup
    // rather than swallowing the map into fullscreen.
    map.on('click', () => setFullscreen(true));
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = undefined;
    };
    // `fullscreen` is a dependency because the shell is portalled to <body> in
    // that state, which gives the container a new DOM node and orphans the old
    // canvas. Re-creating the map is the honest response — it costs one refit
    // per toggle and cannot leave a live map pointing at a detached node.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stores, fullscreen]);

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
    // One finger pans only when there is nothing behind the map to scroll.
    if (fullscreen) map.cooperativeGestures.disable();
    else map.cooperativeGestures.enable();

    // The container's box changes in the same commit that flips this state, so
    // the map has to be told after the browser has applied it — measuring in
    // the same tick reads the old size and leaves the canvas letterboxed.
    const frame = requestAnimationFrame(() => map.resize());
    return () => cancelAnimationFrame(frame);
  }, [fullscreen]);

  // Fullscreen is a fixed overlay, not the Fullscreen API: iOS Safari does not
  // support requestFullscreen on arbitrary elements, and this keeps the WebGL
  // context and the React tree intact across the transition.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const m of markersRef.current) m.remove();
    markersRef.current = [];

    for (const store of stores) {
      const el = document.createElement('div');
      el.style.cssText = `width:14px;height:14px;border-radius:9999px;background:${
        store.available ? '#3f7a4e' : '#a8442f'
      };border:2px solid var(--color-surface);box-shadow:0 1px 3px rgba(0,0,0,0.4);z-index:1`;
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
      // Below the store markers. The user is usually standing AT one of these
      // shops, and this dot is larger than they are — painted on top it hides
      // the very marker the screen exists to report, which is what made the map
      // look all-red while the list showed one store available.
      el.style.cssText = 'position:relative;width:16px;height:16px;z-index:0;';
      el.innerHTML =
        '<div class="user-location-halo" style="position:absolute;inset:0;border-radius:9999px;background:#8f7320;"></div>' +
        '<div style="position:absolute;inset:0;border-radius:9999px;background:#8f7320;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,0.4);"></div>';
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([userCoords.lng, userCoords.lat])
        .addTo(map);
      markersRef.current.push(marker);
    }
    // `fullscreen` belongs here even though no marker reads it: toggling it
    // re-creates the map (see the creation effect), and markers live on the map
    // instance rather than in React's tree, so without this they stay attached
    // to the discarded one and fullscreen opens with an empty map. Caught in
    // the browser — the portal fix passed every DOM assertion while silently
    // dropping all five pins.
  }, [stores, userCoords, mode, fullscreen]);

  // Portalled to <body> when fullscreen. `position: fixed` resolves against the
  // nearest transformed ancestor, not the viewport, and this map lives inside a
  // vaul Drawer whose content carries a transform — so an un-portalled
  // `fixed inset-0` covered only the drawer and left the search form showing
  // above it. Verified in the browser: that is exactly how it first rendered.
  const shell = (
    <div
      className={cn(
        'relative overflow-hidden',
        fullscreen
          ? 'fixed inset-0 z-[60] h-[100dvh] w-screen rounded-none bg-surface'
          : 'h-56 w-full rounded-card shadow-card'
      )}
    >
      <div
        ref={containerRef}
        // touch-pan-y, never touch-none. `touch-none` handed the map every
        // touch, so a drag starting on it could not scroll the sheet past it —
        // the reported bug. Leaving the vertical pan to the browser is what
        // lets MapLibre's cooperative gestures give one-finger drags back to
        // the sheet while still claiming two-finger ones for itself.
        className={cn(
          'h-full w-full',
          fullscreen ? 'touch-none' : 'touch-pan-y',
          mode === 'street' && '[&_.maplibregl-canvas]:dark:invert [&_.maplibregl-canvas]:dark:hue-rotate-180 [&_.maplibregl-canvas]:dark:brightness-75 [&_.maplibregl-canvas]:dark:contrast-90'
        )}
      />
      {/* Expand/collapse in the top-right, inverting between the two icons the
          way a video player does — the same control in the same place means
          "get bigger" and then "give me back the page". */}
      <button
        type="button"
        onClick={() => setFullscreen((v) => !v)}
        aria-label={fullscreen ? 'Karte verkleinern' : 'Karte im Vollbild öffnen'}
        className="absolute right-2 top-2 z-20 flex size-8 items-center justify-center rounded-full bg-surface text-ink shadow-inset"
      >
        {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
      </button>
      <div className="absolute right-12 top-2 z-10 flex gap-0.5 rounded-full bg-surface p-1 text-xs font-bold shadow-inset">
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

  return fullscreen ? createPortal(shell, document.body) : shell;
}
