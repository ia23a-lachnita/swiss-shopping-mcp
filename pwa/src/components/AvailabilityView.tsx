import { useCallback, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import NumberFlow from '@number-flow/react';
import { notifyError, notifySuccess } from '../lib/toast';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ExternalLink,
  LocateFixed,
  MapPin,
  Search,
} from 'lucide-react';

import {
  AVAILABILITY_CHAINS,
  CHAIN_LABELS,
  checkLocation,
  productAvailability,
  reverseGeocode,
  suggestLocations,
  suggestQueries,
  type Chain,
  type LocationSuggestion,
  type Product,
  type StoreWithAvailability,
} from '../api';
import { cn, mapsUrl } from '../lib/utils';
import { notifyIfBackgrounded, requestNotificationPermissionIfNeeded } from '../lib/notify';
import { getTotalHiddenMs } from '../lib/visibilityTracker';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { FilterChip } from './ui/chip';
import { Price } from './ui/price';
import { Skeleton } from './ui/skeleton';
import { SuggestInput } from './ui/suggest-input';
import { ProductSheet } from './ProductSheet';
import { VendorBadge } from './VendorBadge';

interface SearchParams {
  query: string;
  location: string;
  chains: Chain[];
  latitude?: number;
  longitude?: number;
}

function stockBadge(store: StoreWithAvailability): React.JSX.Element {
  if (store.availabilitySupported === false) {
    return <Badge>N/A</Badge>;
  }
  if (!store.available) {
    return <Badge variant="danger">Nicht verfügbar</Badge>;
  }
  if (typeof store.stockCount === 'number' && store.stockCount <= 3) {
    return <Badge variant="warning">Wenige ({store.stockCount})</Badge>;
  }
  return <Badge variant="success">Verfügbar</Badge>;
}

function StoreRow({ store }: { store: StoreWithAvailability }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2.5 border-t border-line py-2 first:border-t-0">
      <span
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded text-xs',
          store.available ? 'bg-success-bg text-success' : 'bg-danger-bg text-danger'
        )}
      >
        {store.available ? '✓' : '✕'}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{store.name}</p>
        <p className="truncate text-xs text-faint">
          {store.address}
          {store.isOpen === true && ' · offen'}
          {store.isOpen === false && ' · geschlossen'}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {stockBadge(store)}
        <a
          href={mapsUrl(store.location.latitude, store.location.longitude)}
          target="_blank"
          rel="noreferrer"
          className="text-faint transition-colors active:text-brand"
          aria-label={`${store.name} auf Google Maps öffnen`}
        >
          <ExternalLink className="size-4" />
        </a>
      </div>
    </div>
  );
}

function AvailabilityCardSkeleton(): React.JSX.Element {
  return (
    <div className="rounded-card bg-surface p-4 shadow-card">
      <div className="flex gap-3">
        <Skeleton className="size-14 shrink-0 rounded" />
        <div className="flex flex-1 flex-col justify-center gap-2">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
      <div className="tear" />
      <div className="space-y-2 py-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    </div>
  );
}

export function AvailabilityView(): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [location, setLocation] = useState('');
  const [chains, setChains] = useState<Chain[]>(['migros', 'coop']);
  const [inStockOnly, setInStockOnly] = useState(false);
  const [openNow, setOpenNow] = useState(false);
  const [params, setParams] = useState<SearchParams | undefined>();
  const [locating, setLocating] = useState(false);
  const [selected, setSelected] = useState<{ product: Product; stores: StoreWithAvailability[] } | undefined>();
  const [editingLocation, setEditingLocation] = useState(true);
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number }>();
  const [openVendor, setOpenVendor] = useState<string>();
  const [validatingLocation, setValidatingLocation] = useState(false);
  const [locationSuggestions, setLocationSuggestions] = useState<LocationSuggestion[]>([]);
  /**
   * `unchecked` also covers "the validation service was unreachable" — the
   * check fails open, so an unverifiable location must stay usable.
   */
  const [locationStatus, setLocationStatus] = useState<'unchecked' | 'valid' | 'invalid'>('unchecked');
  const checkedLocationRef = useRef('');

  const fetchLocationSuggestions = useCallback(async (q: string) => {
    const results = await suggestLocations(q);
    setLocationSuggestions(results);
    return results.map((s) => s.label);
  }, []);

  /**
   * Resolve the typed location against the geocoder. Runs on blur so a wrong
   * location is caught while the user is still looking at the field, rather
   * than after a multi-second search returns results for the wrong town.
   */
  const validateLocation = useCallback(async (value: string): Promise<boolean> => {
    const trimmed = value.trim();
    if (trimmed.length < 2) {
      setLocationStatus('unchecked');
      return true;
    }
    if (checkedLocationRef.current === trimmed) {
      return locationStatus !== 'invalid';
    }

    setValidatingLocation(true);
    try {
      const valid = await checkLocation(trimmed);
      checkedLocationRef.current = trimmed;
      setLocationStatus(valid ? 'valid' : 'invalid');
      return valid;
    } catch {
      // Validation service unreachable — don't block the user, let the real
      // search surface the error.
      checkedLocationRef.current = '';
      setLocationStatus('unchecked');
      return true;
    } finally {
      setValidatingLocation(false);
    }
  }, [locationStatus]);

  const { data: queryResult, isFetching, error } = useQuery({
    queryKey: ['availability', params],
    queryFn: async () => {
      const start = performance.now();
      const hiddenMsAtStart = getTotalHiddenMs();
      const data = await productAvailability({ ...params!, limit: 5 });
      const hiddenMs = getTotalHiddenMs() - hiddenMsAtStart;
      const elapsedMs = Math.max(0, performance.now() - start - hiddenMs);
      void notifyIfBackgrounded('Verfügbarkeit geprüft', `${data.length} Treffer für "${params!.query}"`);
      return { data, elapsedMs, hiddenMs };
    },
    enabled: params !== undefined,
  });
  const data = queryResult?.data;

  async function submit(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const trimmedLocation = location.trim();
    if (!query.trim() || !trimmedLocation || chains.length === 0) return;
    (document.activeElement as HTMLElement | null)?.blur();
    void requestNotificationPermissionIfNeeded();

    // A GPS-resolved location is already known-good; only validate typed text.
    // Normally the blur check has already run and this is a cached no-op — it
    // still has to happen here for the submit-without-blurring path.
    if (!userCoords && !(await validateLocation(trimmedLocation))) {
      notifyError(`Standort "${trimmedLocation}" nicht gefunden.`);
      return;
    }

    setParams({
      query: query.trim(),
      location: trimmedLocation,
      chains,
      latitude: userCoords?.lat,
      longitude: userCoords?.lng,
    });
  }

  function useMyLocation(): void {
    if (!navigator.geolocation) {
      notifyError('Standortdienste werden nicht unterstützt.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const resolved = await reverseGeocode(position.coords.latitude, position.coords.longitude);
          setLocation(resolved);
          setUserCoords({ lat: position.coords.latitude, lng: position.coords.longitude });
          // Came back from the geocoder with coordinates — known-good by construction.
          checkedLocationRef.current = resolved.trim();
          setLocationStatus('valid');
          setEditingLocation(false);
          notifySuccess(`Standort aktualisiert — ${resolved}`);
        } catch (err) {
          notifyError(err instanceof Error ? err.message : 'Standort nicht gefunden.');
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocating(false);
        notifyError('Standortzugriff verweigert.');
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 }
    );
  }

  function selectLocationSuggestion(label: string): void {
    const match = locationSuggestions.find((s) => s.label === label);
    if (match) {
      setUserCoords({ lat: match.latitude, lng: match.longitude });
      // A picked suggestion carries its own coordinates — nothing to verify.
      checkedLocationRef.current = label.trim();
      setLocationStatus('valid');
    }
  }

  function toggleChain(chain: Chain): void {
    setChains((current) =>
      current.includes(chain) ? current.filter((c) => c !== chain) : [...current, chain]
    );
  }

  // Narrowing the chain filter after a search re-filters already-fetched
  // results instantly; checking a chain not part of the last submitted
  // search shows nothing for it until "Verfügbarkeit prüfen" is pressed again.
  const results = (data ?? [])
    .filter((entry) => chains.includes(entry.product.chain))
    .map((entry) => ({
      ...entry,
      stores: entry.stores.filter(
        (store) => (!inStockOnly || store.available) && (!openNow || store.isOpen === true)
      ),
    }))
    .filter((entry) => entry.stores.length > 0 || (!inStockOnly && !openNow));

  return (
    <div className="space-y-4 pt-3">
      <form onSubmit={submit} className="space-y-3">
        {/* Query is the primary, dominant control — what you're looking for matters
            more than where, so it comes first and reads larger than the location chip. */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 z-10 size-4 -translate-y-1/2 text-brand" />
          <SuggestInput
            id="avail-query"
            value={query}
            onChange={setQuery}
            fetchSuggestions={suggestQueries}
            placeholder="Produkt, z.B. Milch"
            enterKeyHint="search"
            clearable
            className="h-12 pl-10 text-base font-medium"
          />
        </div>

        <motion.div layout transition={{ duration: 0.2, ease: 'easeOut' }}>
          <AnimatePresence mode="wait" initial={false}>
            {editingLocation ? (
              <motion.div
                key="edit"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="space-y-1.5"
              >
                <div className="flex items-center gap-2">
                <div className="flex-1">
                  <SuggestInput
                    id="avail-location"
                    value={location}
                    onChange={(value) => {
                      setLocation(value);
                      setUserCoords(undefined);
                      // Every keystroke invalidates the previous verdict.
                      setLocationStatus('unchecked');
                    }}
                    onBlur={(event) => void validateLocation(event.target.value)}
                    fetchSuggestions={fetchLocationSuggestions}
                    onSuggestionSelect={selectLocationSuggestion}
                    placeholder="PLZ oder Ort, z.B. 8001 Zürich"
                    enterKeyHint="search"
                    clearable
                    aria-invalid={locationStatus === 'invalid'}
                    aria-describedby={locationStatus === 'invalid' ? 'avail-location-error' : undefined}
                    className="h-9 text-sm"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={useMyLocation}
                  disabled={locating}
                  aria-label="Meinen Standort verwenden"
                  data-testid="use-location"
                  className="h-9 w-9 shrink-0"
                >
                  <LocateFixed className={cn('size-4', locating && 'animate-spin')} />
                </Button>
                {location.trim() && (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    // A location known not to exist must never be collapsed into
                    // the pill, which reads as "accepted".
                    disabled={locationStatus === 'invalid' || validatingLocation}
                    onClick={async () => {
                      if (await validateLocation(location)) setEditingLocation(false);
                    }}
                    aria-label="Fertig"
                    className="h-9 w-9 shrink-0"
                  >
                    <Check className="size-4" />
                  </Button>
                )}
                </div>
                {locationStatus === 'invalid' && (
                  <p
                    id="avail-location-error"
                    role="alert"
                    data-testid="location-error"
                    className="flex items-center gap-1.5 px-1 text-xs text-danger"
                  >
                    <AlertTriangle className="size-3.5 shrink-0" />
                    Standort nicht gefunden — bitte PLZ, Ort oder Center eingeben.
                  </p>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="pill"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                <button
                  type="button"
                  onClick={() => setEditingLocation(true)}
                  className="flex items-center gap-1.5 rounded-full bg-surface-sunken px-3 py-1.5 text-xs font-medium text-muted shadow-inset active:opacity-80"
                  data-testid="location-pill"
                >
                  <MapPin className="size-3.5 shrink-0 text-brand" />
                  <span className="max-w-40 truncate">{location}</span>
                  <ChevronDown className="size-3 shrink-0 text-faint" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        <div className="flex flex-wrap items-center gap-2">
          {AVAILABILITY_CHAINS.map((chain) => (
            <FilterChip
              key={chain}
              selected={chains.includes(chain)}
              onClick={() => toggleChain(chain)}
            >
              {CHAIN_LABELS[chain]}
            </FilterChip>
          ))}
          <span className="mx-1 h-4 w-px bg-line" />
          <FilterChip
            tone="accent2"
            selected={inStockOnly}
            onClick={() => setInStockOnly((v) => !v)}
          >
            Nur verfügbar
          </FilterChip>
          <FilterChip tone="accent2" selected={openNow} onClick={() => setOpenNow((v) => !v)}>
            Jetzt offen
          </FilterChip>
        </div>

        <Button
          type="submit"
          className="w-full"
          disabled={!query.trim() || !location.trim() || validatingLocation}
          loading={isFetching || validatingLocation}
          loadingText={validatingLocation ? 'Standort wird geprüft…' : 'Wird gesucht…'}
        >
          <Search /> Verfügbarkeit prüfen
        </Button>
      </form>

      {isFetching && (
        <div className="space-y-3" data-testid="avail-loading">
          {[0, 1, 2].map((i) => (
            <AvailabilityCardSkeleton key={i} />
          ))}
        </div>
      )}

      {error instanceof Error && !isFetching && (
        <Card>
          <CardContent className="flex items-center gap-3 text-sm text-danger">
            <AlertTriangle className="size-5 shrink-0" /> {error.message}
          </CardContent>
        </Card>
      )}

      {!isFetching && data && results.length === 0 && (
        <div className="rounded-card bg-surface p-6 text-center shadow-card">
          <p className="font-semibold">Keine Treffer</p>
          <p className="mt-1 text-sm text-faint">Versuch es mit weniger Filtern oder einem anderen Suchbegriff.</p>
          {chains.length < AVAILABILITY_CHAINS.length && (
            <>
              <p className="mt-1 text-xs text-faint">
                Nur {chains.length} von {AVAILABILITY_CHAINS.length} Händlern ausgewählt. Nur Migros und Coop
                bestätigen echten Lagerbestand — weitere Händler zeigen ggf. nur Preis/Katalog ohne
                Verfügbarkeit.
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-3"
                onClick={() => {
                  setChains([...AVAILABILITY_CHAINS]);
                  setParams({ ...params!, chains: [...AVAILABILITY_CHAINS] });
                }}
              >
                Bei allen Händlern suchen
              </Button>
            </>
          )}
        </div>
      )}

      {!isFetching && queryResult && results.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-faint">
          <Search className="size-3" />
          <NumberFlow value={results.length} className="font-mono font-semibold text-ink" /> Ergebnisse in{' '}
          <b className="font-mono font-semibold text-ink">{(queryResult.elapsedMs / 1000).toFixed(1)}s</b>
          {queryResult.hiddenMs > 1000 && (
            <span> (davon {(queryResult.hiddenMs / 1000).toFixed(0)}s im Hintergrund pausiert)</span>
          )}
        </p>
      )}

      <motion.ul
        className="space-y-3"
        initial="hidden"
        animate="visible"
        variants={{ visible: { transition: { staggerChildren: 0.06 } } }}
        data-testid="avail-results"
      >
        <AnimatePresence>
          {!isFetching &&
            results.map(({ product, stores }) => (
              <motion.li
                key={`${product.chain}:${product.id}`}
                layout
                variants={{ hidden: { opacity: 0, y: 12 }, visible: { opacity: 1, y: 0 } }}
                exit={{ opacity: 0, scale: 0.97 }}
              >
                <Card className="p-4">
                  <button
                    type="button"
                    onClick={() => setSelected({ product, stores })}
                    className="flex w-full items-start gap-3 text-left"
                  >
                    {product.image && (
                      <img
                        src={product.image}
                        alt=""
                        className="size-14 shrink-0 rounded bg-white object-contain"
                        loading="lazy"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <VendorBadge
                          chain={product.chain}
                          open={openVendor === `${product.chain}:${product.id}`}
                          onOpenChange={(o) => setOpenVendor(o ? `${product.chain}:${product.id}` : undefined)}
                        />
                        {product.promotionLabel && <Badge variant="promo">{product.promotionLabel}</Badge>}
                      </div>
                      <p className="mt-1 truncate font-semibold">{product.name}</p>
                      <p className="text-sm text-muted">
                        <Price value={product.price.current} className="font-semibold text-ink" />
                        {product.size && <span> · {product.size}</span>}
                      </p>
                    </div>
                  </button>
                  <div className="tear" />
                  {stores.length > 0 ? (
                    <div className="py-1">
                      {stores.map((store) => (
                        <StoreRow key={store.id} store={store} />
                      ))}
                    </div>
                  ) : (
                    <p className="py-2 text-sm text-faint">Keine Filialen gefunden.</p>
                  )}
                  <div className="barcode" />
                </Card>
              </motion.li>
            ))}
        </AnimatePresence>
      </motion.ul>

      <ProductSheet
        product={selected?.product}
        stores={selected?.stores}
        userCoords={userCoords}
        onClose={() => setSelected(undefined)}
      />
    </div>
  );
}
