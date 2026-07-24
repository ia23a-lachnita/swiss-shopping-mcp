import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import NumberFlow from '@number-flow/react';
import { toast } from 'sonner';
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
  productAvailability,
  reverseGeocode,
  type Chain,
  type Product,
  type StoreWithAvailability,
} from '../api';
import { cn, mapsUrl } from '../lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Input } from './ui/input';
import { Price } from './ui/price';
import { Skeleton } from './ui/skeleton';
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
  const queryInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    queryInputRef.current?.focus();
  }, []);

  const { data: queryResult, isFetching, error } = useQuery({
    queryKey: ['availability', params],
    queryFn: async () => {
      const start = performance.now();
      const data = await productAvailability({ ...params!, limit: 5 });
      return { data, elapsedMs: performance.now() - start };
    },
    enabled: params !== undefined,
  });
  const data = queryResult?.data;

  function submit(event?: FormEvent): void {
    event?.preventDefault();
    if (query.trim() && location.trim() && chains.length > 0) {
      setParams({
        query: query.trim(),
        location: location.trim(),
        chains,
        latitude: userCoords?.lat,
        longitude: userCoords?.lng,
      });
    }
  }

  function useMyLocation(): void {
    if (!navigator.geolocation) {
      toast.error('Standortdienste werden nicht unterstützt.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const resolved = await reverseGeocode(position.coords.latitude, position.coords.longitude);
          setLocation(resolved);
          setUserCoords({ lat: position.coords.latitude, lng: position.coords.longitude });
          setEditingLocation(false);
          toast.success(`Standort aktualisiert — ${resolved}`);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Standort nicht gefunden.');
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocating(false);
        toast.error('Standortzugriff verweigert.');
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 }
    );
  }

  function toggleChain(chain: Chain): void {
    setChains((current) =>
      current.includes(chain) ? current.filter((c) => c !== chain) : [...current, chain]
    );
  }

  const results = (data ?? [])
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
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-brand" />
          <Input
            ref={queryInputRef}
            id="avail-query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Produkt, z.B. Milch"
            autoComplete="off"
            enterKeyHint="search"
            className="h-12 pl-10 text-base font-medium"
          />
        </div>

        {editingLocation ? (
          <div className="flex items-center gap-2">
            <Input
              id="avail-location"
              value={location}
              onChange={(e) => {
                setLocation(e.target.value);
                setUserCoords(undefined);
              }}
              placeholder="PLZ oder Ort, z.B. 8001 Zürich"
              autoComplete="postal-code"
              enterKeyHint="search"
              className="h-9 text-sm"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={useMyLocation}
              disabled={locating}
              aria-label="Meinen Standort verwenden"
              data-testid="use-location"
              className="h-9 w-9"
            >
              <LocateFixed className={cn('size-4', locating && 'animate-spin')} />
            </Button>
            {location.trim() && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setEditingLocation(false)}
                aria-label="Fertig"
                className="h-9 w-9"
              >
                <Check className="size-4" />
              </Button>
            )}
          </div>
        ) : (
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
        )}

        <div className="flex flex-wrap items-center gap-2">
          {AVAILABILITY_CHAINS.map((chain) => (
            <button
              key={chain}
              type="button"
              onClick={() => toggleChain(chain)}
              className={cn(
                'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                chains.includes(chain)
                  ? 'bg-brand text-brand-ink'
                  : 'bg-surface-sunken text-muted shadow-inset'
              )}
              aria-pressed={chains.includes(chain)}
            >
              {CHAIN_LABELS[chain]}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-line" />
          <button
            type="button"
            onClick={() => setInStockOnly((v) => !v)}
            className={cn(
              'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
              inStockOnly ? 'bg-accent2-bg text-accent2' : 'bg-surface-sunken text-muted shadow-inset'
            )}
            aria-pressed={inStockOnly}
          >
            Nur verfügbar
          </button>
          <button
            type="button"
            onClick={() => setOpenNow((v) => !v)}
            className={cn(
              'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
              openNow ? 'bg-accent2-bg text-accent2' : 'bg-surface-sunken text-muted shadow-inset'
            )}
            aria-pressed={openNow}
          >
            Jetzt offen
          </button>
        </div>

        <Button type="submit" className="w-full" disabled={!query.trim() || !location.trim()}>
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
        </div>
      )}

      {!isFetching && queryResult && results.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-faint">
          <Search className="size-3" />
          <NumberFlow value={results.length} className="font-mono font-semibold text-ink" /> Ergebnisse in{' '}
          <b className="font-mono font-semibold text-ink">{(queryResult.elapsedMs / 1000).toFixed(1)}s</b>
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
        onClose={() => setSelected(undefined)}
      />
    </div>
  );
}
