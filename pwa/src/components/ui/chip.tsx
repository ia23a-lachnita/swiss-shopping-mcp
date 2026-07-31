import { cn } from '../../lib/utils';

export interface FilterChipProps {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  /** Use the secondary (deal/amber) accent instead of the brand accent. */
  tone?: 'brand' | 'accent2';
  className?: string;
}

/**
 * Toggleable filter pill, shared by the chain selectors in Search / Compare /
 * Availability (which previously carried three identical copies of this markup).
 *
 * The selected state is a *tint* — 15% brand wash + a brand border + a stronger
 * label — not a solid brand fill. A row of seven fully-saturated gold pills sat
 * directly above the primary CTA and out-shouted it; the tint keeps the selection
 * obvious while leaving the submit button the loudest thing on screen. The border
 * is what carries the state at a glance, so the unselected variant reserves a
 * transparent one to avoid a 1px size jump on toggle.
 */
export function FilterChip({
  selected,
  onClick,
  children,
  tone = 'brand',
  className,
}: FilterChipProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
        selected
          ? tone === 'accent2'
            ? 'border-accent2 bg-accent2/15 text-accent2'
            : 'border-brand bg-brand/15 text-brand-strong'
          : 'border-transparent bg-surface-sunken text-muted shadow-inset',
        className
      )}
    >
      {children}
    </button>
  );
}
