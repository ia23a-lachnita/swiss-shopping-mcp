import { cn } from '../../lib/utils';

/** Swiss shelf-tag convention: francs large, rappen/cents smaller and top-aligned. */
export function Price({
  value,
  currency = 'CHF',
  className,
}: {
  value: number;
  currency?: string;
  className?: string;
}): React.JSX.Element {
  const [main, cents] = value.toFixed(2).split('.');
  return (
    <span className={cn('font-mono', className)}>
      {currency} {main}.<span className="frac">{cents}</span>
    </span>
  );
}
