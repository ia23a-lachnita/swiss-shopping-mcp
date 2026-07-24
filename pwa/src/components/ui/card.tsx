import type { HTMLAttributes } from 'react';

import { cn } from '../../lib/utils';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        'rounded-card bg-surface shadow-card transition-[transform,box-shadow] duration-150 ease-out',
        'hover:-translate-y-0.5 hover:shadow-card-lg active:translate-y-0 active:scale-[0.995] active:shadow-card-sm',
        'motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100',
        className
      )}
      {...props}
    />
  );
}

export function CardContent({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('p-4', className)} {...props} />;
}
