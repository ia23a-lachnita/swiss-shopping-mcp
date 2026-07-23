import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, ExternalLink, LocateFixed, Search } from 'lucide-react';

import {
  AVAILABILITY_CHAINS,
  CHAIN_LABELS,
  productAvailability,
  reverseGeocode,
  type Chain,
  type Product,
  type StoreWithAvailability,
} from '../api';
import { cn, formatPrice, mapsUrl } from '../lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Input } from './ui/input';
import { Skeleton } from './ui/skeleton';
import { ProductSheet } from './ProductSheet';

interface SearchParams {
  query: string;
  location: string;
  chains: Chain[];
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
    <li className="flex items-center gap-3 py-2">
      <span
        className={cn(
          'size-2 shrink-0 rounded-full',
          store.isOpen === true && 'bg-emerald-500',
          store.isOpen === false && 'bg-red-500',
          store.isOpen === undefined && 'bg-zinc-300 dark:bg-zinc-600'
        )}
        title={store.isOpen === true ? 'Offen' : store.isOpen === false ? 'Geschlossen' : 'Öffnungszeiten unbekannt'}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{store.name}</p>
        <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{store.address}</p>
      </div>
      {stockBadge(store)}
      <a
        href={mapsUrl(store.location.latitude, store.location.longitude)}
        target="_blank"
        rel="noreferrer"
        className="text-zinc-400 transition-colors active:text-emerald-600"
        aria-label={`${store.name} auf Google Maps öffnen`}
      >
        <ExternalLink className="size-4" />
      </a>
    </li>
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
  const [locateError, setLocateError] = useState<string>();
  const [selected, setSelected] = useState<Product | undefined>();

  const { data, isFetching, error } = useQuery({
    queryKey: ['availability', params],
    queryFn: () => productAvailability({ ...params!, limit: 5 }),
    enabled: params !== undefined,
  });

  function submit(event?: FormEvent): void {
    event?.preventDefault();
    if (query.trim() && location.trim() && chains.length > 0) {
      setParams({ query: query.trim(), location: location.trim(), chains });
    }
  }

  function useMyLocation(): void {
    setLocateError(undefined);
    if (!navigator.geolocation) {
      setLocateError('Standortdienste werden nicht unterstützt.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const resolved = await reverseGeocode(
            position.coords.latitude,
            position.coords.longitude
          );
          setLocation(resolved);
        } catch (err) {
          setLocateError(err instanceof Error ? err.message : 'Standort nicht gefunden.');
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocating(false);
        setLocateError('Standortzugriff verweigert.');
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
        (store) =>
          (!inStockOnly || store.available) && (!openNow || store.isOpen === true)
      ),
    }))
    .filter((entry) => entry.stores.length > 0 || (!inStockOnly && !openNow));

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="space-y-3">
        <Input
          id="avail-query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Produkt, z.B. Milch"
          autoComplete="off"
          enterKeyHint="search"
        />
        <div className="flex gap-2">
          <Input
            id="avail-location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="PLZ oder Ort, z.B. 8001 Zürich"
            autoComplete="postal-code"
            enterKeyHint="search"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={useMyLocation}
            disabled={locating}
            aria-label="Meinen Standort verwenden"
            data-testid="use-location"
          >
            <LocateFixed className={cn(locating && 'animate-spin')} />
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {AVAILABILITY_CHAINS.map((chain) => (
            <button
              key={chain}
              type="button"
              onClick={() => toggleChain(chain)}
              className={cn(
                'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                chains.includes(chain)
                  ? 'border-emerald-600 bg-emerald-600 text-white'
                  : 'border-zinc-300 bg-white text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
              )}
              aria-pressed={chains.includes(chain)}
            >
              {CHAIN_LABELS[chain]}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
          <button
            type="button"
            onClick={() => setInStockOnly((v) => !v)}
            className={cn(
              'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
              inStockOnly
                ? 'border-emerald-600 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                : 'border-zinc-300 bg-white text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
            )}
            aria-pressed={inStockOnly}
          >
            Nur verfügbar
          </button>
          <button
            type="button"
            onClick={() => setOpenNow((v) => !v)}
            className={cn(
              'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
              openNow
                ? 'border-emerald-600 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                : 'border-zinc-300 bg-white text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
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

      {locateError && (
        <p className="flex items-center gap-2 text-sm text-amber-600" role="alert">
          <AlertTriangle className="size-4" /> {locateError}
        </p>
      )}

      {isFetching && (
        <div className="space-y-3" data-testid="avail-loading">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      )}

      {error instanceof Error && !isFetching && (
        <Card>
          <CardContent className="flex items-center gap-3 text-sm text-red-600">
            <AlertTriangle className="size-5 shrink-0" /> {error.message}
          </CardContent>
        </Card>
      )}

      {!isFetching && data && results.length === 0 && (
        <p className="py-8 text-center text-sm text-zinc-500">
          Keine Treffer für diese Filter.
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
                variants={{
                  hidden: { opacity: 0, y: 12 },
                  visible: { opacity: 1, y: 0 },
                }}
                exit={{ opacity: 0, scale: 0.97 }}
              >
                <Card>
                  <CardContent>
                    <button
                      type="button"
                      onClick={() => setSelected(product)}
                      className="flex w-full items-start gap-3 text-left active:opacity-80"
                    >
                      {product.image && (
                        <img
                          src={product.image}
                          alt=""
                          className="size-14 shrink-0 rounded-lg bg-white object-contain"
                          loading="lazy"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <Badge>{CHAIN_LABELS[product.chain]}</Badge>
                          {product.promotionLabel && (
                            <Badge variant="promo">{product.promotionLabel}</Badge>
                          )}
                        </div>
                        <p className="mt-1 truncate font-medium">{product.name}</p>
                        <p className="text-sm text-zinc-500">
                          {formatPrice(product.price.current)}
                          {product.size && <span> · {product.size}</span>}
                        </p>
                      </div>
                    </button>
                    {stores.length > 0 ? (
                      <ul className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-800">
                        {stores.map((store) => (
                          <StoreRow key={store.id} store={store} />
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-sm text-zinc-500">Keine Filialen gefunden.</p>
                    )}
                  </CardContent>
                </Card>
              </motion.li>
            ))}
        </AnimatePresence>
      </motion.ul>

      <ProductSheet product={selected} onClose={() => setSelected(undefined)} />
    </div>
  );
}
