import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import NumberFlow from '@number-flow/react';
import { AlertTriangle, Minus, Plus, Scale } from 'lucide-react';

import { ALL_CHAINS, comparePrices, suggestQueries, type Chain, type Product } from '../api';
import { notifyIfBackgrounded, requestNotificationPermissionIfNeeded } from '../lib/notify';
import { getTotalHiddenMs } from '../lib/visibilityTracker';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { FilterChip } from './ui/chip';
import { Input } from './ui/input';
import { Price } from './ui/price';
import { Skeleton } from './ui/skeleton';
import { SuggestInput } from './ui/suggest-input';
import { ProductSheet } from './ProductSheet';
import { VendorBadge } from './VendorBadge';

function CompareRowSkeleton(): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-card bg-surface p-3 shadow-card">
      <Skeleton className="size-4 shrink-0 rounded" />
      <Skeleton className="size-11 shrink-0 rounded" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-2.5 w-1/3" />
      </div>
      <Skeleton className="h-5 w-14 shrink-0 rounded" />
    </div>
  );
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function sameChains(a: Chain[], b: Chain[]): boolean {
  return a.length === b.length && a.every((chain) => b.includes(chain));
}

export function CompareView(): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [chains, setChains] = useState<Chain[]>([...ALL_CHAINS]);
  const [quantity, setQuantity] = useState(1);
  // Deliberately no `quantity`: it is a display multiplier applied client-side
  // (see `offers` below), so changing it must not become part of the query key
  // and trigger a network round trip to perform a multiplication.
  const [submitted, setSubmitted] = useState<{ query: string; chains: Chain[] } | undefined>();
  const [openVendor, setOpenVendor] = useState<string>();
  const [selected, setSelected] = useState<Product | undefined>();

  const { data: queryResult, isFetching, error } = useQuery({
    queryKey: ['compare', submitted],
    queryFn: async () => {
      const start = performance.now();
      const hiddenMsAtStart = getTotalHiddenMs();
      const data = await comparePrices(submitted!);
      const hiddenMs = getTotalHiddenMs() - hiddenMsAtStart;
      const elapsedMs = Math.max(0, performance.now() - start - hiddenMs);
      void notifyIfBackgrounded('Vergleich abgeschlossen', `${data.offers.length} Angebote für "${submitted!.query}"`);
      return { data, elapsedMs, hiddenMs };
    },
    enabled: submitted !== undefined,
  });
  const result = queryResult?.data;
  // Narrowing the chain filter after a search re-filters the already-fetched
  // offers instantly; checking a chain not part of the last submitted search
  // shows nothing for it until "Preise vergleichen" is pressed again — which
  // is what `isDirty` below re-enables the button for.
  //
  // The pack count is applied here rather than refetched. `effectivePrice` is
  // the per-pack price and the server's own `totalPrice` is just that times the
  // submitted quantity, so multiplying locally is exact arithmetic, not an
  // estimate. Before this, moving the stepper with offers on screen changed
  // nothing whatsoever until the next search.
  const offers = result
    ? [...result.offers]
        .filter((o) => chains.includes(o.chain))
        .map((o) => ({ ...o, totalPrice: roundCurrency(o.effectivePrice * quantity) }))
        .sort((a, b) => a.totalPrice - b.totalPrice)
    : [];

  // A `Grundpreis` (CHF/kg, CHF/l) is only derivable for chains that publish a
  // unit price — Migros and Coop today; Aldi and Lidl publish neither it nor a
  // pack size. Showing "kein Grundpreis" on every row when *nobody* has one is
  // pure noise, so the marker appears only when some other offer does have one
  // and its absence would therefore make the comparison look uneven.
  const anyBaseUnitPrice = offers.some((o) => o.baseUnitPrice !== undefined && o.baseUnit);

  // What pressing the button would fetch, versus what produced the offers on
  // screen. Quantity is absent on purpose: it never needs a round trip.
  const isDirty =
    submitted === undefined ||
    query.trim() !== submitted.query ||
    !sameChains(chains, submitted.chains);
  const canSubmit = query.trim().length > 0 && chains.length > 0;
  // Editing the query or the vendors mid-search turns the button back into an
  // action, matching SearchView: nobody should have to wait out a comparison
  // they have already changed their mind about.
  const restartable = isFetching && canSubmit && isDirty;
  // Nothing left to do — the offers on screen already answer exactly this
  // query for exactly these vendors. The button was always inert here, since
  // react-query dedupes an identical key, but it stayed fully lit, so the only
  // feedback a shopper got was a press that did nothing. An error is excluded
  // so a failed comparison can always be retried unchanged — tested against
  // `!error` because react-query reports "no error" as `null`, not `undefined`.
  const upToDate = !isFetching && !isDirty && result !== undefined && !error;

  function submit(event?: FormEvent): void {
    event?.preventDefault();
    if (canSubmit) {
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

  function setClampedQuantity(next: number): void {
    setQuantity(Math.min(99, Math.max(1, Math.round(next) || 1)));
  }

  return (
    <div className="space-y-4 pt-3">
      <form onSubmit={submit} className="space-y-3">
        <div className="relative">
          <Scale className="pointer-events-none absolute left-3.5 top-1/2 z-10 size-4 -translate-y-1/2 text-brand" />
          <SuggestInput
            value={query}
            onChange={setQuery}
            fetchSuggestions={suggestQueries}
            placeholder="Produkt vergleichen, z.B. Butter"
            enterKeyHint="search"
            clearable
            className="h-12 pl-10 text-base font-medium"
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-faint">Anzahl Packungen (gilt für alle Produkte)</span>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={() => setClampedQuantity(quantity - 1)}
              disabled={quantity <= 1}
              aria-label="Weniger Packungen"
            >
              <Minus />
            </Button>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={99}
              value={quantity}
              onChange={(e) => setClampedQuantity(Number(e.target.value))}
              className="h-9 w-14 text-center text-sm"
              aria-label="Anzahl Packungen"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={() => setClampedQuantity(quantity + 1)}
              disabled={quantity >= 99}
              aria-label="Mehr Packungen"
            >
              <Plus />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {ALL_CHAINS.map((chain) => (
            <FilterChip
              key={chain}
              selected={chains.includes(chain)}
              onClick={() => toggleChain(chain)}
            >
              {chain === 'ottos' ? "Otto's" : chain.charAt(0).toUpperCase() + chain.slice(1)}
            </FilterChip>
          ))}
        </div>
        <Button
          type="submit"
          className="w-full"
          disabled={!canSubmit || upToDate}
          loading={isFetching && !restartable}
          loadingText="Wird verglichen…"
        >
          <Scale />{' '}
          {restartable
            ? 'Neuen Vergleich starten'
            : isDirty && result !== undefined
              ? 'Neu vergleichen'
              : 'Preise vergleichen'}
        </Button>
        {chains.length === 0 && (
          <p className="text-xs text-danger">Mindestens ein Händler muss ausgewählt sein.</p>
        )}
      </form>

      {isFetching && (
        <div className="space-y-2.5" data-testid="compare-loading">
          {[0, 1, 2].map((i) => (
            <CompareRowSkeleton key={i} />
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

      {!isFetching && result && offers.length === 0 && (
        <div className="rounded-card bg-surface p-6 text-center shadow-card">
          <p className="font-semibold">Keine Angebote gefunden</p>
        </div>
      )}

      {!isFetching && queryResult && offers.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-faint">
          <Scale className="size-3" />
          <NumberFlow value={offers.length} className="font-mono font-semibold text-ink" /> Angebote in{' '}
          <b className="font-mono font-semibold text-ink">{(queryResult.elapsedMs / 1000).toFixed(1)}s</b>
          {queryResult.hiddenMs > 1000 && (
            <span> (davon {(queryResult.hiddenMs / 1000).toFixed(0)}s im Hintergrund pausiert)</span>
          )}
        </p>
      )}

      <motion.ul
        className="space-y-2.5"
        initial="hidden"
        animate="visible"
        variants={{ visible: { transition: { staggerChildren: 0.05 } } }}
      >
        <AnimatePresence>
          {!isFetching &&
            offers.map((offer, i) => (
              <motion.li
                key={`${offer.chain}:${offer.product.id}`}
                layout
                variants={{ hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0 } }}
                exit={{ opacity: 0 }}
              >
                <div className="flex items-center gap-3 rounded-card bg-surface p-3 shadow-card">
                  <span className="font-mono text-sm font-bold text-faint">#{i + 1}</span>
                  <button
                    type="button"
                    onClick={() => setSelected(offer.product)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    {offer.product.image && (
                      <img src={offer.product.image} alt="" className="size-11 shrink-0 rounded bg-white object-contain" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <VendorBadge
                          chain={offer.chain}
                          open={openVendor === `${offer.chain}:${offer.product.id}`}
                          onOpenChange={(o) => setOpenVendor(o ? `${offer.chain}:${offer.product.id}` : undefined)}
                        />
                        {i === 0 && <Badge variant="promo">Bestpreis</Badge>}
                      </div>
                      <p className="truncate text-sm font-medium">{offer.product.name}</p>
                      {/*
                        The PBV Grundpreis, which is the only figure that makes
                        two different pack sizes comparable. This used to render
                        `unitPrice` / `comparisonUnit`, but the default
                        comparison basis is `packPrice`, so that line said
                        "CHF 2.95 / pack" next to a total of CHF 2.95.
                      */}
                      {offer.baseUnitPrice !== undefined && offer.baseUnit ? (
                        <p className="text-xs text-faint">
                          <Price value={offer.baseUnitPrice} className="text-xs" /> / {offer.baseUnit}
                        </p>
                      ) : (
                        anyBaseUnitPrice && (
                          <p className="text-xs text-faint/60">Kein Grundpreis</p>
                        )
                      )}
                    </div>
                  </button>
                  <div className="shrink-0 text-right">
                    <Price value={offer.totalPrice} className="text-base font-bold" />
                    {quantity > 1 && (
                      <p className="text-[0.65rem] text-faint">
                        à <Price value={offer.effectivePrice} className="text-[0.65rem]" />
                      </p>
                    )}
                  </div>
                </div>
              </motion.li>
            ))}
        </AnimatePresence>
      </motion.ul>

      <ProductSheet product={selected} onClose={() => setSelected(undefined)} />
    </div>
  );
}
