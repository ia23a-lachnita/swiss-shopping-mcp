import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide',
  {
    variants: {
      variant: {
        default: 'bg-surface-sunken text-muted shadow-inset normal-case font-medium tracking-normal',
        success: 'bg-success-bg text-success',
        warning: 'bg-accent2-bg text-accent2',
        danger: 'bg-danger-bg text-danger',
        // Rotated rubber-stamp treatment for deal callouts — the one place accent2 is bold.
        promo:
          'rounded border-[1.5px] border-accent2 bg-accent2-bg/40 text-accent2 -rotate-3 font-extrabold',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
