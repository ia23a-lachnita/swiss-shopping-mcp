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
import { notifyIfBackgrounded, requestNotificationPermissionIfNeeded } from '../lib/notify';
import { getTotalHiddenMs } from '../lib/visibilityTracker';
import { ProductSheet } from './ProductSheet';
import { VendorBadge } from './VendorBadge';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { FilterChip } from './ui/chip';
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
  /** Chains that have not reported yet, so the UI can name the last straggler. */
  pending: Chain[];
  /**
   * Likely finish time for the *slowest chain still outstanding*, as a ms
   * offset from the search start. Recomputed on every chain that reports in, so
   * once the slow chains are done the countdown collapses instead of running
   * out the original worst-case estimate. Undefined once nothing is pending.
   */
  etaMs?: number;
  /** The same instant, derived from what those chains are still *allowed* to take. */
  etaCeilingMs?: number;
}

/** Only used if the server omits `fallbackEtaMs`; mirrors ADAPTER_SOFT_TIMEOUT_MS. */
const DEFAULT_CHAIN_ETA_MS = 6000;

interface EtaInputs {
  etaMsByChain: Record<string, number | undefined>;
  budgetMsByChain: Record<string, number | undefined>;
  fallbackMs: number;
  postFanOutMs: number;
}

/**
 * Remaining-time estimate over chains that have not reported yet — a range, not
 * a promise.
 *
 * The single number this replaces was the max of the pending chains' p75s, and
 * it under-promised for three structural reasons (reported from a real phone:
 * "it told me 5s but took actually 12s"): a p75 is wrong a quarter of the time
 * by construction and the max of several p75s is not the p75 of the max; the
 * estimate never grew when a straggler blew through its own p75, it just
 * counted down to zero; and it modelled the vendor fan-out only, ignoring the
 * web-augmentation and merge/rank work that follows it.
 *
 * `ceilingMs` answers all three: it is built from each pending chain's hard
 * budget (what `raceWithTimeout` still allows it) plus the server's
 * post-fan-out allowance, so "up to X" cannot be falsified by a slow vendor.
 */
function pendingEta(
  pending: Iterable<string>,
  inputs: EtaInputs
): { likelyMs: number; ceilingMs: number } | undefined {
  const chains = [...pending];
  if (chains.length === 0) return undefined;

  const likelyMs = Math.max(...chains.map((chain) => inputs.etaMsByChain[chain] ?? inputs.fallbackMs));
  const budgetMs = Math.max(...chains.map((chain) => inputs.budgetMsByChain[chain] ?? inputs.fallbackMs));
  return { likelyMs, ceilingMs: budgetMs + inputs.postFanOutMs };
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
  const etaInputsRef = useRef<EtaInputs>({
    etaMsByChain: {},
    budgetMsByChain: {},
    fallbackMs: DEFAULT_CHAIN_ETA_MS,
    postFanOutMs: 0,
  });
  const pendingChainsRef = useRef<Set<Chain>>(new Set());

  const { data: queryResult, isFetching, error } = useQuery({
    queryKey: ['search', submitted],
    // `signal` is react-query's: consuming it is what makes this query
    // cancellable, so submitting a new query mid-search tears the old
    // EventSource down instead of leaving it streaming into the void.
    queryFn: async ({ signal }) => {
      const start = performance.now();
      const hiddenMsAtStart = getTotalHiddenMs();
      searchStartRef.current = start;
      setProgress(undefined);
      const data = await streamSearchProducts(
        // No limit. The 12 that used to be here was a payload cap nobody had
        // revisited, and it was also what made the live counter park at "12
        // gefunden" while chains kept reporting. A broad query ("Milch",
        // "Brot") measures at 66–80 products / ~80KB across seven chains,
        // which is a normal page for a comparison app.
        { ...submitted! },
        {
          signal,
          onInit: (init) => {
            etaInputsRef.current = {
              etaMsByChain: init.etaMsByChain,
              budgetMsByChain: init.budgetMsByChain ?? {},
              fallbackMs: init.fallbackEtaMs ?? DEFAULT_CHAIN_ETA_MS,
              postFanOutMs: init.postFanOutMs ?? 0,
            };
            pendingChainsRef.current = new Set(init.chains);
            const eta = pendingEta(pendingChainsRef.current, etaInputsRef.current);
            setProgress({
              responded: 0,
              total: init.totalChains,
              productsSoFar: 0,
              pending: [...pendingChainsRef.current],
              etaMs: eta?.likelyMs,
              etaCeilingMs: eta?.ceilingMs,
            });
          },
          onProgress: (event) => {
            // Drop the chain that just answered, then re-estimate from what is
            // still outstanding. The old code locked the estimate in at `init`
            // and never revised it, so the countdown kept running against the
            // slowest chain long after that chain had already replied.
            pendingChainsRef.current.delete(event.chain);
            const eta = pendingEta(pendingChainsRef.current, etaInputsRef.current);
            setProgress({
              responded: event.respondedCount,
              total: event.totalCount,
              productsSoFar: event.productsSoFar,
              pending: [...pendingChainsRef.current],
              etaMs: eta?.likelyMs,
              etaCeilingMs: eta?.ceilingMs,
            });
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
  const elapsedSinceStartMs = performance.now() - searchStartRef.current;
  const remainingMs = (target: number | undefined): number | undefined =>
    target !== undefined ? Math.max(0, target - elapsedSinceStartMs) : undefined;
  const etaRemainingMs = remainingMs(progress?.etaMs);
  const etaCeilingRemainingMs = remainingMs(progress?.etaCeilingMs);
  void tick; // triggers the re-render that recomputes the countdowns above

  // Four honest states, in priority order:
  //  - every chain has answered → the remaining time is the merge/rank step,
  //    which has no per-chain estimate, so stop counting and say so;
  //  - both bounds alive → show the range, never a single confident number;
  //  - the likely time is spent but the budget is not → "up to Xs", naming the
  //    straggler once it is the only one left (the 6/7 case that was reported);
  //  - even the budget is spent → say it is taking longer than usual.
  // Skeletons mean "nothing to show yet". Once results for this exact query
  // exist — restored from the persisted cache after a reload, or left over from
  // a previous run — a refetch keeps them on screen instead of blanking them.
  const showSkeletons = isFetching && visibleProducts.length === 0;

  const allChainsIn = progress !== undefined && progress.responded >= progress.total;
  const withinLikely = etaRemainingMs !== undefined && etaRemainingMs > 1000;
  const withinBudget = etaCeilingRemainingMs !== undefined && etaCeilingRemainingMs > 1000;
  const lastStraggler =
    progress?.pending.length === 1 ? CHAIN_LABELS[progress.pending[0]] : undefined;

  // What pressing the button would fetch, versus what produced the results on
  // screen. Narrowing the chain filter re-filters locally, but *widening* it
  // needs a real refetch, so an added vendor has to count as dirty.
  const isDirty =
    submitted === undefined ||
    query.trim() !== submitted.query ||
    chains.length !== submitted.chains.length ||
    chains.some((chain) => !submitted.chains.includes(chain));
  const canSubmit = query.trim().length > 0 && chains.length > 0;
  // While a search runs, editing the query (or the chain selection) turns the
  // button back into an action: the shopper who mistyped should not have to
  // wait out a search they no longer want.
  const restartable = isFetching && canSubmit && isDirty;
  // The results on screen already answer exactly this query for exactly these
  // vendors, so the button has nothing to do. It was already inert — an
  // identical react-query key is deduped — but it stayed fully lit, so the only
  // feedback was a press that did nothing. Errors stay retryable — tested with
  // `!error` because react-query reports "no error" as `null`, not `undefined`.
  const upToDate = !isFetching && !isDirty && data !== undefined && !error;

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
            clearable
            className="h-12 pl-10 text-base font-medium"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {ALL_CHAINS.map((chain) => (
            <FilterChip
              key={chain}
              selected={chains.includes(chain)}
              onClick={() => toggleChain(chain)}
            >
              {CHAIN_LABELS[chain]}
            </FilterChip>
          ))}
        </div>
        <Button
          type="submit"
          className="w-full"
          disabled={!canSubmit || upToDate}
          loading={isFetching && !restartable}
          loadingText="Wird gesucht…"
        >
          <Search />{' '}
          {restartable
            ? 'Neue Suche starten'
            : isDirty && data !== undefined
              ? 'Neu suchen'
              : 'Suchen'}
        </Button>
        {chains.length === 0 && (
          <p className="text-xs text-danger">Mindestens ein Händler muss ausgewählt sein.</p>
        )}
      </form>

      {isFetching && (
        <div className="space-y-3" data-testid="search-loading">
          {progress && showSkeletons && (
            <p className="flex items-center gap-1.5 text-xs text-faint" data-testid="search-progress">
              <Search className="size-3 animate-pulse" />
              <NumberFlow value={progress.productsSoFar} className="font-mono font-semibold text-ink" />
              <span>
                {' '}
                Ergebnisse bisher ({progress.responded}/{progress.total} Händler)
              </span>
              {allChainsIn ? (
                <span> · Ergebnisse werden zusammengeführt…</span>
              ) : withinLikely && withinBudget ? (
                <span>
                  {' '}
                  · noch{' '}
                  <b className="font-mono font-semibold text-ink">
                    {Math.ceil((etaRemainingMs as number) / 1000)}–
                    {Math.ceil((etaCeilingRemainingMs as number) / 1000)}s
                  </b>
                </span>
              ) : withinBudget ? (
                <span>
                  {' '}
                  · {lastStraggler ? `warte auf ${lastStraggler}, ` : ''}bis zu{' '}
                  <b className="font-mono font-semibold text-ink">
                    {Math.ceil((etaCeilingRemainingMs as number) / 1000)}s
                  </b>
                </span>
              ) : (
                <span> · dauert länger als üblich…</span>
              )}
            </p>
          )}
          {showSkeletons ? (
            [0, 1, 2].map((i) => <ProductCardSkeleton key={i} />)
          ) : (
            // Results for this query are already on screen (restored from the
            // persisted cache, or a previous run of the same search). Replacing
            // them with skeletons for the background refresh would throw away
            // the instant paint that persisting the cache exists to provide.
            <p className="text-xs text-faint" data-testid="search-refreshing">
              Ergebnisse werden aktualisiert…
            </p>
          )}
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

      {/* Rendered whenever results exist, including mid-refresh — see showSkeletons. */}
      <motion.ul
        className="space-y-3"
        initial="hidden"
        animate="visible"
        // Per-item stagger, but the whole list must still finish arriving in
        // under a second: without the old `limit: 12` a broad query renders
        // 60–80 cards, and a flat 0.05s each would take four seconds to settle.
        variants={{
          visible: {
            transition: { staggerChildren: Math.min(0.05, 0.9 / Math.max(visibleProducts.length, 1)) },
          },
        }}
        data-testid="search-results"
      >
        <AnimatePresence>
          {!showSkeletons &&
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
