import { useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import NumberFlow from '@number-flow/react';
import { AlertTriangle, Search } from 'lucide-react';

import { ALL_CHAINS, CHAIN_LABELS, searchProducts, type Chain, type Product } from '../api';
import { cn } from '../lib/utils';
import { ProductSheet } from './ProductSheet';
import { VendorBadge } from './VendorBadge';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Input } from './ui/input';
import { Price } from './ui/price';
import { Skeleton } from './ui/skeleton';

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

export function SearchView(): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [chains, setChains] = useState<Chain[]>([...ALL_CHAINS]);
  const [submitted, setSubmitted] = useState<{ query: string; chains: Chain[] } | undefined>();
  const [selected, setSelected] = useState<Product | undefined>();
  const [openVendor, setOpenVendor] = useState<string>();
  const queryInputRef = useRef<HTMLInputElement>(null);

  const { data: queryResult, isFetching, error } = useQuery({
    queryKey: ['search', submitted],
    queryFn: async () => {
      const start = performance.now();
      const data = await searchProducts({ ...submitted!, limit: 12 });
      return { data, elapsedMs: performance.now() - start };
    },
    enabled: submitted !== undefined,
  });
  const data = queryResult?.data;

  function submit(event?: FormEvent): void {
    event?.preventDefault();
    if (query.trim() && chains.length > 0) {
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
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-brand" />
          <Input
            ref={queryInputRef}
            id="search-query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Produkt suchen, z.B. Zahnpasta"
            autoComplete="off"
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
        <Button type="submit" className="w-full" disabled={!query.trim()}>
          <Search /> Suchen
        </Button>
      </form>

      {isFetching && (
        <div className="space-y-3" data-testid="search-loading">
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

      {!isFetching && data && data.products.length === 0 && (
        <div className="rounded-card bg-surface p-6 text-center shadow-card">
          <p className="font-semibold">Keine Produkte gefunden</p>
        </div>
      )}

      {!isFetching && queryResult && data && data.products.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-faint">
          <Search className="size-3" />
          <NumberFlow value={data.products.length} className="font-mono font-semibold text-ink" /> Ergebnisse in{' '}
          <b className="font-mono font-semibold text-ink">{(queryResult.elapsedMs / 1000).toFixed(1)}s</b>
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
            data?.products.map((product) => (
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
