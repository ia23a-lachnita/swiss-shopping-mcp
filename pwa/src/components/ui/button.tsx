import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';

import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-brand text-brand-ink shadow-card-sm active:opacity-90',
        outline:
          'border border-[color:var(--color-outline-border)] bg-surface text-ink shadow-card-sm active:bg-surface-sunken',
        ghost: 'text-muted active:bg-surface-sunken',
      },
      size: {
        default: 'h-11 px-4',
        sm: 'h-9 px-3 text-xs',
        icon: 'h-11 w-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Shows a pulsing outline ring + spinner and forces disabled, without the dimmed "inert" look native `disabled` gives. */
  loading?: boolean;
  /** Replaces children while loading (e.g. "Wird gesucht…"). Falls back to children if omitted. */
  loadingText?: React.ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, loadingText, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(buttonVariants({ variant, size }), loading && '!opacity-100', className)}
      {...props}
    >
      {loading && (
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          aria-hidden="true"
        >
          <rect
            x="1"
            y="1"
            width="calc(100% - 2px)"
            height="calc(100% - 2px)"
            rx="8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            pathLength={100}
            className="button-loading-border"
          />
        </svg>
      )}
      {loading ? (
        <>
          <Loader2 className="animate-spin" />
          {loadingText ?? children}
        </>
      ) : (
        children
      )}
    </button>
  )
);
Button.displayName = 'Button';
