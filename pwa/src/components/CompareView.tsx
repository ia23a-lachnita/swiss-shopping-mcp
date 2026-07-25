import { useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import NumberFlow from '@number-flow/react';
import { AlertTriangle, Scale } from 'lucide-react';

import { ALL_CHAINS, comparePrices, type Chain } from '../api';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Input } from './ui/input';
import { Price } from './ui/price';
import { Skeleton } from './ui/skeleton';
import { VendorBadge } from './VendorBadge';

export function CompareView(): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [chains, setChains] = useState<Chain[]>([...ALL_CHAINS]);
  const [quantity, setQuantity] = useState(1);
  const [submitted, setSubmitted] = useState<{ query: string; chains: Chain[]; quantity: number } | undefined>();
  const [openVendor, setOpenVendor] = useState<string>();
  const queryInputRef = useRef<HTMLInputElement>(null);

  const { data: queryResult, isFetching, error } = useQuery({
    queryKey: ['compare', submitted],
    queryFn: async () => {
      const start = performance.now();
      const data = await comparePrices(submitted!);
      return { data, elapsedMs: performance.now() - start };
    },
    enabled: submitted !== undefined,
  });
  const result = queryResult?.data;
  const offers = result ? [...result.offers].sort((a, b) => a.effectivePrice - b.effectivePrice) : [];

  function submit(event?: FormEvent): void {
    event?.preventDefault();
    if (query.trim() && chains.length > 0) {
      setSubmitted({ query: query.trim(), chains, quantity });
    }
  }

  function toggleChain(chain: Chain): void {
    setChains((current) =>
      current.includes(chain) ? current.filter((c) => c !== chain) : [...current, chain]
    );
  }

  return (
    <div className="space-y-4 pb-4 pt-3">
      <form onSubmit={submit} className="space-y-3">
        <div className="relative">
          <Scale className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-brand" />
          <Input
            ref={queryInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Produkt vergleichen, z.B. Butter"
            autoComplete="off"
            enterKeyHint="search"
            className="h-12 pl-10 text-base font-medium"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-faint">Menge</span>
          <Input
            type="number"
            min={1}
            max={100}
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
            className="h-9 w-20 text-sm"
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
              {chain === 'ottos' ? "Otto's" : chain.charAt(0).toUpperCase() + chain.slice(1)}
            </button>
          ))}
        </div>
        <Button type="submit" className="w-full" disabled={!query.trim()}>
          <Scale /> Preise vergleichen
        </Button>
      </form>

      {isFetching && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-card" />
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
                    {offer.comparisonEligible && offer.unitPrice && offer.comparisonUnit && (
                      <p className="text-xs text-faint">
                        <Price value={offer.unitPrice} className="text-xs" /> / {offer.comparisonUnit}
                      </p>
                    )}
                  </div>
                  <Price value={offer.effectivePrice} className="shrink-0 text-base font-bold" />
                </div>
              </motion.li>
            ))}
        </AnimatePresence>
      </motion.ul>
    </div>
  );
}
