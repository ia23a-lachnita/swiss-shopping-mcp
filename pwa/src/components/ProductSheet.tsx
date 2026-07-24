import { lazy, Suspense, useState } from 'react';
import { Drawer } from 'vaul';
import { ExternalLink } from 'lucide-react';

import { CHAIN_LABELS, type Product, type StoreWithAvailability } from '../api';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Price } from './ui/price';
import { Skeleton } from './ui/skeleton';
import { VendorBadge } from './VendorBadge';

// maplibre-gl is heavy (~1MB) — only worth loading when a product actually has
// stores to show (i.e. opened from Availability), not on every sheet open.
const ProductMap = lazy(() => import('./ProductMap').then((m) => ({ default: m.ProductMap })));

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
  stores,
  onClose,
}: {
  product: Product | undefined;
  /** Only present when opened from the Availability view — scopes the embedded map to this one product. */
  stores?: StoreWithAvailability[];
  onClose: () => void;
}): React.JSX.Element {
  const [vendorOpen, setVendorOpen] = useState(false);

  return (
    <Drawer.Root open={product !== undefined} onOpenChange={(open) => !open && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[85dvh] max-w-2xl rounded-t-3xl bg-surface outline-none">
          <div className="mx-auto mt-3 h-1.5 w-10 rounded-full bg-line" />
          {product && (
            <div className="overflow-y-auto p-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
              <Drawer.Title className="sr-only">{product.name}</Drawer.Title>
              {product.image && (
                <img src={product.image} alt="" className="mx-auto h-40 rounded bg-white object-contain" />
              )}
              <div className="mt-3 flex items-center gap-2">
                <VendorBadge chain={product.chain} open={vendorOpen} onOpenChange={setVendorOpen} />
                {product.promotionLabel && <Badge variant="promo">{product.promotionLabel}</Badge>}
                {product.category && <Badge>{product.category}</Badge>}
              </div>
              <h2 className="mt-2 text-lg font-semibold">{product.name}</h2>
              {product.brand && <p className="text-sm text-faint">{product.brand}</p>}
              <p className="mt-2 flex items-baseline gap-2 text-xl font-bold">
                <Price value={product.price.current} />
                {product.price.original && (
                  <span className="font-mono text-sm font-normal text-faint line-through">
                    CHF {product.price.original.toFixed(2)}
                  </span>
                )}
                {product.size && <span className="text-sm font-normal text-faint">{product.size}</span>}
              </p>

              {stores && stores.length > 0 && (
                <section className="mt-4">
                  <h3 className="mb-2 text-sm font-semibold text-muted">Filialen in der Nähe</h3>
                  <Suspense fallback={<Skeleton className="h-56 w-full rounded-card" />}>
                    <ProductMap stores={stores} />
                  </Suspense>
                </section>
              )}

              {product.nutrition && (
                <section className="mt-4">
                  <h3 className="text-sm font-semibold text-muted">Nährwerte (pro 100g)</h3>
                  <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
                    {NUTRITION_LABELS.filter(({ key }) => typeof product.nutrition?.[key] === 'number').map(
                      ({ key, label, unit }) => (
                        <div key={key} className="rounded bg-surface-sunken p-2 text-center shadow-inset">
                          <dt className="text-xs text-faint">{label}</dt>
                          <dd className="font-mono font-medium">
                            {product.nutrition![key]} {unit}
                          </dd>
                        </div>
                      )
                    )}
                  </dl>
                </section>
              )}

              {product.ingredients && product.ingredients.length > 0 && (
                <section className="mt-4">
                  <h3 className="text-sm font-semibold text-muted">Zutaten</h3>
                  <p className="mt-1 text-sm text-muted">{product.ingredients.join(', ')}</p>
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
