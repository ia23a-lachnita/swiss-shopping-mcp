import { Drawer } from 'vaul';
import { ExternalLink } from 'lucide-react';

import { CHAIN_LABELS, type Product } from '../api';
import { formatPrice } from '../lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

const NUTRITION_LABELS: Array<{ key: keyof NonNullable<Product['nutrition']>; label: string; unit: string }> = [
  { key: 'energyKcal', label: 'Energie', unit: 'kcal' },
  { key: 'protein', label: 'Protein', unit: 'g' },
  { key: 'carbs', label: 'Kohlenhydrate', unit: 'g' },
  { key: 'fat', label: 'Fett', unit: 'g' },
  { key: 'fiber', label: 'Ballaststoffe', unit: 'g' },
  { key: 'sugar', label: 'Zucker', unit: 'g' },
];

export function ProductSheet({
  product,
  onClose,
}: {
  product: Product | undefined;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Drawer.Root open={product !== undefined} onOpenChange={(open) => !open && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[85dvh] max-w-2xl rounded-t-3xl bg-white outline-none dark:bg-zinc-900">
          <div className="mx-auto mt-3 h-1.5 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700" />
          {product && (
            <div className="overflow-y-auto p-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
              <Drawer.Title className="sr-only">{product.name}</Drawer.Title>
              {product.image && (
                <img
                  src={product.image}
                  alt=""
                  className="mx-auto h-40 rounded-xl bg-white object-contain"
                />
              )}
              <div className="mt-3 flex items-center gap-2">
                <Badge>{CHAIN_LABELS[product.chain]}</Badge>
                {product.promotionLabel && <Badge variant="promo">{product.promotionLabel}</Badge>}
                {product.category && <Badge>{product.category}</Badge>}
              </div>
              <h2 className="mt-2 text-lg font-semibold text-zinc-900 dark:text-zinc-50">{product.name}</h2>
              {product.brand && <p className="text-sm text-zinc-500">{product.brand}</p>}
              <p className="mt-2 text-xl font-bold text-zinc-900 dark:text-zinc-50">
                {formatPrice(product.price.current)}
                {product.price.original && (
                  <span className="ml-2 text-sm font-normal text-zinc-400 line-through">
                    {formatPrice(product.price.original)}
                  </span>
                )}
                {product.size && (
                  <span className="ml-2 text-sm font-normal text-zinc-500">{product.size}</span>
                )}
              </p>

              {product.nutrition && (
                <section className="mt-4">
                  <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                    Nährwerte (pro 100g)
                  </h3>
                  <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
                    {NUTRITION_LABELS.filter(
                      ({ key }) => typeof product.nutrition?.[key] === 'number'
                    ).map(({ key, label, unit }) => (
                      <div
                        key={key}
                        className="rounded-lg bg-zinc-100 p-2 text-center dark:bg-zinc-800"
                      >
                        <dt className="text-xs text-zinc-500">{label}</dt>
                        <dd className="font-medium text-zinc-900 dark:text-zinc-50">
                          {product.nutrition![key]} {unit}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}

              {product.ingredients && product.ingredients.length > 0 && (
                <section className="mt-4">
                  <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                    Zutaten
                  </h3>
                  <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                    {product.ingredients.join(', ')}
                  </p>
                </section>
              )}

              {product.productUrl && (
                <Button
                  className="mt-5 w-full"
                  variant="outline"
                  onClick={() => window.open(product.productUrl, '_blank', 'noreferrer')}
                >
                  <ExternalLink /> Bei {CHAIN_LABELS[product.chain]} ansehen
                </Button>
              )}
            </div>
          )}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
