import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';

import { cn } from '../../lib/utils';

const buttonVariants = cva(
  // The icon-sizing rule deliberately excludes .loading-trace-svg. It is a
  // descendant-selector rule, so it outranks the plain `w-full h-full` on the
  // loading overlay and was silently clamping that SVG's viewport to 16px —
  // which is what actually made the border trace draw as a 14px stub, since the
  // rect sizes itself as a percentage of that viewport.
  'relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:pointer-events-none disabled:opacity-50 [&_svg:not(.loading-trace-svg)]:size-4 [&_svg:not(.loading-trace-svg)]:shrink-0',
  {
    variants: {
      // --loading-trace is the stroke colour of the loading border trace (see
      // .button-loading-border in index.css). It is per-variant because the trace
      // has to read as *light* against whatever the button's own background is:
      // a warm white on the solid gold fill, the gold accent on a plain surface.
      variant: {
        default:
          'bg-brand text-brand-ink shadow-card-sm active:opacity-90 [--loading-trace:rgba(255,250,240,0.92)]',
        outline:
          'border border-[color:var(--color-outline-border)] bg-surface text-ink shadow-card-sm active:bg-surface-sunken [--loading-trace:var(--color-brand)]',
        ghost: 'text-muted active:bg-surface-sunken [--loading-trace:var(--color-brand)]',
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
  /** Shows a traveling border trace + spinner and forces disabled, without the dimmed "inert" look native `disabled` gives. */
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
          className="loading-trace-svg pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          aria-hidden="true"
        >
          {/* Geometry and stroke colour live in .button-loading-border (index.css) —
              calc() is invalid in an SVG geometry *attribute* and silently collapses
              the rect. These attributes are only the no-CSS-geometry-support
              fallback: a full-bleed rect whose stroke is clipped by 1px rather than
              a rect that disappears. pathLength=100 normalises the perimeter so the
              two dash segments stay proportional at any button width.

              Five stacked copies, not one: each draws a shorter dash centred in the
              same slot at a higher alpha, which is what makes every travelling
              segment fade from its own centre outward. The layering (and why a
              gradient cannot do this) is documented on the CSS side. */}
          {[1, 2, 3, 4, 5].map((layer) => (
            <rect
              key={layer}
              width="100%"
              height="100%"
              rx="8"
              fill="none"
              strokeWidth="2"
              strokeLinecap="round"
              pathLength={100}
              className={`button-loading-border button-loading-border--taper-${layer}`}
            />
          ))}
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
