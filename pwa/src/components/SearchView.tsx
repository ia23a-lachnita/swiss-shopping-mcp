import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import NumberFlow from '@number-flow/react';
import { AlertTriangle, Search } from 'lucide-react';

import {
  ALL_CHAINS,
  CHAIN_LABELS,
  streamSearchProducts,
  suggestQueries,
  type Chain,
  type Product,
} from '../api';
import { cn } from '../lib/utils';
import { notifyIfBackgrounded, requestNotificationPermissionIfNeeded } from '../lib/notify';
import { getTotalHiddenMs } from '../lib/visibilityTracker';
import { ProductSheet } from './ProductSheet';
import { VendorBadge } from './VendorBadge';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Price } from './ui/price';
import { Skeleton } from './ui/skeleton';
import { SuggestInput } from './ui/suggest-input';

function ProductCardSkeleton(): React.JSX.Element {
  return (
    <div className="rounded-card bg-surface p-4 shadow-card">
      <div className="flex gap-3">
        <Skeleton className="size-14 shrink-0 rounded" />
        <div className="flex flex-1 flex-col justify-center gap-2">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
    </div>
  );
}

interface SearchProgress {
  responded: number;
  total: number;
  productsSoFar: number;
  etaMs?: number;
}

export function SearchView(): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [chains, setChains] = useState<Chain[]>([...ALL_CHAINS]);
  const [submitted, setSubmitted] = useState<{ query: string; chains: Chain[] } | undefined>();
  const [selected, setSelected] = useState<Product | undefined>();
  const [openVendor, setOpenVendor] = useState<string>();
  const [progress, setProgress] = useState<SearchProgress | undefined>();
  const [tick, setTick] = useState(0);
  const searchStartRef = useRef(0);

  const { data: queryResult, isFetching, error } = useQuery({
    queryKey: ['search', submitted],
    queryFn: async () => {
      const start = performance.now();
      const hiddenMsAtStart = getTotalHiddenMs();
      searchStartRef.current = start;
      setProgress(undefined);
      const data = await streamSearchProducts(
        { ...submitted!, limit: 12 },
        {
          onInit: (init) => {
            const known = init.chains
              .map((chain) => init.etaMsByChain[chain])
              .filter((ms): ms is number => typeof ms === 'number');
            setProgress({
              responded: 0,
              total: init.totalChains,
              productsSoFar: 0,
              etaMs: known.length > 0 ? Math.max(...known) : undefined,
            });
          },
          onProgress: (event) => {
            setProgress((prev) => ({
              responded: event.respondedCount,
              total: event.totalCount,
              productsSoFar: event.productsSoFar,
              etaMs: prev?.etaMs,
            }));
          },
        }
      );
      const hiddenMs = getTotalHiddenMs() - hiddenMsAtStart;
      const elapsedMs = Math.max(0, performance.now() - start - hiddenMs);
      void notifyIfBackgrounded('Suche abgeschlossen', `${data.products.length} Ergebnisse für "${submitted!.query}"`);
      return { data, elapsedMs, hiddenMs };
    },
    enabled: submitted !== undefined,
  });
  const data = queryResult?.data;
  // Narrowing the chain filter after a search re-filters the already-fetched
  // results instantly (no network round trip); checking a chain that wasn't
  // part of the last submitted search naturally shows nothing for it until
  // "Suchen" is pressed again, since that data was never fetched.
  const visibleProducts = data ? data.products.filter((p) => chains.includes(p.chain)) : [];

  // Ticks the ETA countdown live while a search is in flight.
  useEffect(() => {
    if (!isFetching) return;
    const interval = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(interval);
  }, [isFetching]);
  const etaRemainingMs =
    progress?.etaMs !== undefined
      ? Math.max(0, progress.etaMs - (performance.now() - searchStartRef.current))
      : undefined;
  void tick; // triggers the re-render that recomputes etaRemainingMs above

  function submit(event?: FormEvent): void {
    event?.preventDefault();
    if (query.trim() && chains.length > 0) {
      // Enter-key submission (common with enterKeyHint="search" on mobile) never
      // blurs the input on its own — without this, the keyboard and the
      // suggestions dropdown both stay open under the now-loading results.
      (document.activeElement as HTMLElement | null)?.blur();
      void requestNotificationPermissionIfNeeded();
      setSubmitted({ query: query.trim(), chains });
    }
  }

  function toggleChain(chain: Chain): void {
    setChains((current) =>
      current.includes(chain) ? current.filter((c) => c !== chain) : [...current, chain]
    );
  }

  return (
    <div className="space-y-4 pt-3">
      <form onSubmit={submit} className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 z-10 size-4 -translate-y-1/2 text-brand" />
          <SuggestInput
            id="search-query"
            value={query}
            onChange={setQuery}
            fetchSuggestions={suggestQueries}
            placeholder="Produkt suchen, z.B. Zahnpasta"
            enterKeyHint="search"
            className="h-12 pl-10 text-base font-medium"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {ALL_CHAINS.map((chain) => (
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
        </div>
        <Button
          type="submit"
          className="w-full"
          disabled={!query.trim()}
          loading={isFetching}
          loadingText="Wird gesucht…"
        >
          <Search /> Suchen
        </Button>
      </form>

      {isFetching && (
        <div className="space-y-3" data-testid="search-loading">
          {progress && (
            <p className="flex items-center gap-1.5 text-xs text-faint" data-testid="search-progress">
              <Search className="size-3 animate-pulse" />
              <NumberFlow value={progress.productsSoFar} className="font-mono font-semibold text-ink" />
              <span>
                {' '}
                Ergebnisse bisher ({progress.responded}/{progress.total} Händler)
              </span>
              {progress.responded < progress.total && etaRemainingMs !== undefined && etaRemainingMs > 1000 ? (
                <span>
                  {' '}
                  · noch ~
                  <b className="font-mono font-semibold text-ink">{Math.ceil(etaRemainingMs / 1000)}s</b>
                </span>
              ) : (
                (progress.responded >= progress.total ||
                  (etaRemainingMs !== undefined && etaRemainingMs <= 1000)) && (
                  <span> · gleich fertig…</span>
                )
              )}
            </p>
          )}
          {[0, 1, 2].map((i) => (
            <ProductCardSkeleton key={i} />
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

      {!isFetching && data && visibleProducts.length === 0 && (
        <div className="rounded-card bg-surface p-6 text-center shadow-card">
          <p className="font-semibold">Keine Produkte gefunden</p>
          {chains.length < ALL_CHAINS.length && (
            <>
              <p className="mt-1 text-sm text-faint">
                Nur {chains.length} von {ALL_CHAINS.length} Händlern ausgewählt.
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-3"
                onClick={() => {
                  setChains([...ALL_CHAINS]);
                  setSubmitted({ query: submitted!.query, chains: [...ALL_CHAINS] });
                }}
              >
                Bei allen Händlern suchen
              </Button>
            </>
          )}
        </div>
      )}

      {!isFetching && queryResult && data && visibleProducts.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-faint">
          <Search className="size-3" />
          <NumberFlow value={visibleProducts.length} className="font-mono font-semibold text-ink" /> Ergebnisse in{' '}
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
        variants={{ visible: { transition: { staggerChildren: 0.05 } } }}
        data-testid="search-results"
      >
        <AnimatePresence>
          {!isFetching &&
            visibleProducts.map((product) => (
              <motion.li
                key={`${product.chain}:${product.id}`}
                layout
                variants={{ hidden: { opacity: 0, y: 12 }, visible: { opacity: 1, y: 0 } }}
                exit={{ opacity: 0, scale: 0.97 }}
              >
                <Card className="p-4">
                  <button
                    type="button"
                    onClick={() => setSelected(product)}
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
                        {product.price.original && (
                          <span className="ml-1.5 font-mono text-xs text-faint line-through">
                            CHF {product.price.original.toFixed(2)}
                          </span>
                        )}
                        {product.size && <span> · {product.size}</span>}
                      </p>
                    </div>
                  </button>
                  <div className="barcode" />
                </Card>
              </motion.li>
            ))}
        </AnimatePresence>
      </motion.ul>

      <ProductSheet product={selected} onClose={() => setSelected(undefined)} />
    </div>
  );
}
