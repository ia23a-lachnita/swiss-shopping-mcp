import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Search } from 'lucide-react';

import { ALL_CHAINS, CHAIN_LABELS, searchProducts, type Chain, type Product } from '../api';
import { cn, formatPrice } from '../lib/utils';
import { ProductSheet } from './ProductSheet';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Input } from './ui/input';
import { Skeleton } from './ui/skeleton';

export function SearchView(): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [chains, setChains] = useState<Chain[]>([...ALL_CHAINS]);
  const [submitted, setSubmitted] = useState<{ query: string; chains: Chain[] } | undefined>();
  const [selected, setSelected] = useState<Product | undefined>();

  const { data, isFetching, error } = useQuery({
    queryKey: ['search', submitted],
    queryFn: () => searchProducts({ ...submitted!, limit: 12 }),
    enabled: submitted !== undefined,
  });

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
    <div className="space-y-4">
      <form onSubmit={submit} className="space-y-3">
        <Input
          id="search-query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Produkt suchen, z.B. Zahnpasta"
          autoComplete="off"
          enterKeyHint="search"
        />
        <div className="flex flex-wrap gap-2">
          {ALL_CHAINS.map((chain) => (
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
        </div>
        <Button type="submit" className="w-full" disabled={!query.trim()}>
          <Search /> Suchen
        </Button>
      </form>

      {isFetching && (
        <div className="grid grid-cols-2 gap-3" data-testid="search-loading">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-44 w-full" />
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

      {!isFetching && data && data.products.length === 0 && (
        <p className="py-8 text-center text-sm text-zinc-500">Keine Produkte gefunden.</p>
      )}

      <motion.ul
        className="grid grid-cols-2 gap-3"
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
                variants={{
                  hidden: { opacity: 0, y: 12 },
                  visible: { opacity: 1, y: 0 },
                }}
                exit={{ opacity: 0, scale: 0.97 }}
              >
                <Card
                  className="h-full cursor-pointer transition-transform active:scale-[0.98]"
                  onClick={() => setSelected(product)}
                >
                  <CardContent className="flex h-full flex-col p-3">
                    {product.image ? (
                      <img
                        src={product.image}
                        alt=""
                        className="mx-auto h-24 w-full rounded-lg bg-white object-contain"
                        loading="lazy"
                      />
                    ) : (
                      <div className="h-24 w-full rounded-lg bg-zinc-100 dark:bg-zinc-800" />
                    )}
                    <div className="mt-2 flex items-center gap-1.5">
                      <Badge>{CHAIN_LABELS[product.chain]}</Badge>
                      {product.promotionLabel && (
                        <Badge variant="promo">{product.promotionLabel}</Badge>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm font-medium">{product.name}</p>
                    <div className="mt-auto pt-1 text-sm">
                      <span className="font-semibold">{formatPrice(product.price.current)}</span>
                      {product.price.original && (
                        <span className="ml-1.5 text-xs text-zinc-400 line-through">
                          {formatPrice(product.price.original)}
                        </span>
                      )}
                      {product.size && (
                        <span className="ml-1.5 text-xs text-zinc-500">{product.size}</span>
                      )}
                    </div>
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
