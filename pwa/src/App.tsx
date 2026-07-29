import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig, motion } from 'framer-motion';
import { MapPin, MessageCircle, Scale, Search, Activity } from 'lucide-react';
import { Toaster } from 'sonner';

import { AvailabilityView } from './components/AvailabilityView';
import { SearchView } from './components/SearchView';
import { CompareView } from './components/CompareView';
import { StatusView } from './components/StatusView';
import { cn } from './lib/utils';

// The AI SDK (ai/@ai-sdk/react) is real weight (~230kB gzipped) that only the
// Chat tab needs — code-split it the same way ProductSheet already does for
// the heavy maplibre-based ProductMap.
const ChatView = lazy(() => import('./components/ChatView').then((m) => ({ default: m.ChatView })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

type Tab = 'availability' | 'search' | 'compare' | 'chat' | 'status';

const TABS: Array<{ id: Tab; label: string; icon: typeof MapPin }> = [
  { id: 'availability', label: 'In der Nähe', icon: MapPin },
  { id: 'search', label: 'Suche', icon: Search },
  { id: 'compare', label: 'Vergleich', icon: Scale },
  { id: 'chat', label: 'Chat', icon: MessageCircle },
  { id: 'status', label: 'Status', icon: Activity },
];

const VIEWS: Record<Tab, React.ComponentType> = {
  availability: AvailabilityView,
  search: SearchView,
  compare: CompareView,
  chat: ChatView,
  status: StatusView,
};

export default function App(): React.JSX.Element {
  // Availability answers the core "can I grab it right now?" question, so it
  // is the landing view (see docs/active/DELIVERY_MODEL_DECISION.md).
  const [tab, setTab] = useState<Tab>('availability');
  // Views stay mounted once visited so switching tabs never discards a view's
  // local state (search/compare results, scroll position, in-progress input).
  // Each view is only mounted on its first visit, not eagerly at app start.
  const [visitedTabs, setVisitedTabs] = useState<Set<Tab>>(() => new Set(['availability']));
  const navRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setVisitedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, [tab]);

  // Installed/standalone PWAs (unlike a regular browser tab) restore the
  // exact DOM focus state a WebView had when the OS backgrounded it — if a
  // text input was focused when the user last left the app, resuming it
  // silently re-focuses that input and pops the keyboard again. No app code
  // ever calls .focus() (that was already removed), so this can only be
  // countered by explicitly blurring on resume.
  useEffect(() => {
    function handleVisibilityChange(): void {
      if (document.visibilityState !== 'visible') return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        active.blur();
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Measure the nav's real rendered height (content + safe-area-inset-bottom)
  // instead of guessing a fixed padding value that can silently drift out of
  // sync — the exact bug that caused the reported nav/content overlap.
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const set = (): void =>
      document.documentElement.style.setProperty('--nav-h', `${el.getBoundingClientRect().height}px`);
    set();
    const observer = new ResizeObserver(set);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Same real-measurement approach for the sticky header — VendorBadge's
  // popover reads both --header-h and --nav-h to keep clear of the fixed
  // chrome instead of guessing pixel constants that drift from safe-area insets.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const set = (): void =>
      document.documentElement.style.setProperty('--header-h', `${el.getBoundingClientRect().height}px`);
    set();
    const observer = new ResizeObserver(set);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <div className="mx-auto flex min-h-dvh max-w-2xl flex-col bg-bg font-sans text-ink" style={{ paddingBottom: 'var(--nav-h)' }}>
          <header
            ref={headerRef}
            className="sticky top-0 z-30 flex h-[calc(env(safe-area-inset-top)+3.25rem)] items-center border-b border-line bg-bg/80 px-4 backdrop-blur-md"
          >
            <h1 className="text-xl font-bold tracking-tight">
              Swiss <span className="text-brand">Shopping</span>
            </h1>
          </header>

          <main className="flex-1 px-4">
            <Suspense fallback={null}>
              {TABS.map(({ id }) => {
                if (!visitedTabs.has(id)) return null;
                const ViewComponent = VIEWS[id];
                return (
                  <div key={id} className={tab === id ? undefined : 'hidden'}>
                    <ViewComponent />
                  </div>
                );
              })}
            </Suspense>
          </main>

          <nav
            ref={navRef}
            className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/90 backdrop-blur"
          >
            <div className="mx-auto flex max-w-2xl pb-[env(safe-area-inset-bottom)]">
              {TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={cn(
                    'relative flex flex-1 flex-col items-center gap-1 py-2.5 text-[0.65rem] font-medium transition-colors',
                    tab === id ? 'text-brand' : 'text-faint'
                  )}
                  aria-current={tab === id ? 'page' : undefined}
                >
                  {tab === id && (
                    <motion.span
                      layoutId="tab-indicator"
                      className="absolute inset-x-6 top-0 h-0.5 rounded-full bg-brand"
                    />
                  )}
                  <Icon className="size-5" />
                  {label}
                </button>
              ))}
            </div>
          </nav>
        </div>
        <Toaster
          position="bottom-center"
          offset={{ bottom: 'calc(var(--nav-h, 4.5rem) + 0.75rem)' }}
          swipeDirections={['bottom', 'left', 'right']}
          toastOptions={{
            unstyled: true,
            style: { width: '100%' },
          }}
        />
      </MotionConfig>
    </QueryClientProvider>
  );
}
