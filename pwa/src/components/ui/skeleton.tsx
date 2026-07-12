import type { HTMLAttributes } from 'react';

import { cn } from '../../lib/utils';

export function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn('animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-800', className)}
      {...props}
    />
  );
}
