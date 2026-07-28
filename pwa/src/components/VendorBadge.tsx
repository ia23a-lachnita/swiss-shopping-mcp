import { useEffect } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useQuery } from '@tanstack/react-query';

import { CHAIN_LABELS, sourceStatus, type Chain, type CapabilityStatusValue } from '../api';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';

const CAPABILITY_LABELS: Record<string, string> = {
  productSearch: 'Produktsuche',
  storeSearch: 'Filialsuche',
  availability: 'Verfügbarkeit',
  promotions: 'Angebote',
  nutrition: 'Nährwerte',
};

const STATUS_LABELS: Record<CapabilityStatusValue, string> = {
  'live-beta': 'Aktiv (Beta)',
  'live-stable': 'Aktiv',
  degraded: 'Eingeschränkt',
  'source-auditing': 'Wird geprüft',
  blocked: 'Blockiert',
  unsupported: 'Nicht verfügbar',
};

function statusDotClass(status: CapabilityStatusValue): string {
  if (status === 'live-beta' || status === 'live-stable') return 'bg-success';
  if (status === 'degraded' || status === 'source-auditing') return 'bg-accent2';
  return 'bg-faint';
}

// Radix's collision detection uses the viewport as its implicit boundary and
// has no notion of this app's own fixed header/bottom nav — a uniform
// collisionPadding lets the popover render half-hidden behind either on
// initial open (not just after scrolling). --header-h/--nav-h are real
// measured pixel heights (see App.tsx's ResizeObserver), not guesses, so this
// stays correct across devices with different safe-area insets.
function fixedChromePadding(): { top: number; right: number; bottom: number; left: number } {
  const root = getComputedStyle(document.documentElement);
  const headerH = parseFloat(root.getPropertyValue('--header-h')) || 60;
  const navH = parseFloat(root.getPropertyValue('--nav-h')) || 80;
  return { top: headerH + 8, right: 12, bottom: navH + 8, left: 12 };
}

/**
 * Chain tag that opens a popover with that vendor's real declared capability
 * status on tap. Viewport-aware positioning (flip/shift) comes from Radix's
 * Popover, which wraps Floating UI internally — not hand-rolled.
 */
export function VendorBadge({
  chain,
  open,
  onOpenChange,
}: {
  chain: Chain;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const { data } = useQuery({
    queryKey: ['source-status'],
    queryFn: sourceStatus,
    staleTime: 5 * 60_000,
    enabled: open,
  });

  const rows = data?.filter((s) => s.chain === chain) ?? [];

  // Radix's collision detection keeps the popover anchored to its trigger on
  // scroll, but has no notion of this app's own sticky header/bottom nav —
  // if the trigger scrolls underneath them, the popover (z-50) still renders
  // on top instead of being covered. Closing on scroll is the standard,
  // robust fix for a transient popover rather than fighting collision
  // boundaries for two independently-positioned fixed/sticky bars.
  // The listener is armed on a short delay rather than immediately: opening
  // the popover can itself trigger a scroll (e.g. the trigger being brought
  // into view), which would otherwise close it again in the same tick.
  useEffect(() => {
    if (!open) return;
    function handleScroll(): void {
      onOpenChange(false);
    }
    const timer = window.setTimeout(() => {
      window.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('scroll', handleScroll, { capture: true });
    };
  }, [open, onOpenChange]);

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button type="button" onClick={(e) => e.stopPropagation()}>
          <Badge className="cursor-pointer active:opacity-70">{CHAIN_LABELS[chain]}</Badge>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          collisionPadding={fixedChromePadding()}
          avoidCollisions
          sideOffset={6}
          className="z-50 w-64 rounded-card bg-surface p-3 text-sm shadow-card-lg outline-none"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-faint">
            {CHAIN_LABELS[chain]} — Fähigkeiten
          </p>
          <ul className="mt-2 space-y-1.5">
            {rows.length === 0 && <li className="text-xs text-faint">Lädt…</li>}
            {rows.map((r) => (
              <li key={r.capability} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-1.5">
                  <span className={cn('size-1.5 shrink-0 rounded-full', statusDotClass(r.status))} />
                  {CAPABILITY_LABELS[r.capability] ?? r.capability}
                </span>
                <span className="text-faint">{STATUS_LABELS[r.status]}</span>
              </li>
            ))}
          </ul>
          <Popover.Arrow className="fill-surface" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
