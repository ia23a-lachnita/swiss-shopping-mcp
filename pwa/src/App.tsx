import { useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { MapPin, Scale, Search, Activity } from 'lucide-react';
import { Toaster } from 'sonner';

import { AvailabilityView } from './components/AvailabilityView';
import { SearchView } from './components/SearchView';
import { CompareView } from './components/CompareView';
import { StatusView } from './components/StatusView';
import { cn } from './lib/utils';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

type Tab = 'availability' | 'search' | 'compare' | 'status';

const TABS: Array<{ id: Tab; label: string; icon: typeof MapPin }> = [
  { id: 'availability', label: 'In der Nähe', icon: MapPin },
  { id: 'search', label: 'Suche', icon: Search },
  { id: 'compare', label: 'Vergleich', icon: Scale },
  { id: 'status', label: 'Status', icon: Activity },
];

const VIEWS: Record<Tab, React.ComponentType> = {
  availability: AvailabilityView,
  search: SearchView,
  compare: CompareView,
  status: StatusView,
};

export default function App(): React.JSX.Element {
  // Availability answers the core "can I grab it right now?" question, so it
  // is the landing view (see docs/active/DELIVERY_MODEL_DECISION.md).
  const [tab, setTab] = useState<Tab>('availability');
  const navRef = useRef<HTMLElement>(null);

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

  const ActiveView = VIEWS[tab];

  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <div className="mx-auto flex min-h-dvh max-w-2xl flex-col bg-bg font-sans text-ink" style={{ paddingBottom: 'var(--nav-h)' }}>
          <header className="sticky top-0 z-30 flex h-[calc(env(safe-area-inset-top)+3.25rem)] items-center border-b border-line bg-bg/80 px-4 backdrop-blur-md">
            <h1 className="text-xl font-bold tracking-tight">
              Swiss <span className="text-brand">Shopping</span>
            </h1>
          </header>

          <main className="flex-1 px-4">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                <ActiveView />
              </motion.div>
            </AnimatePresence>
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
          position="top-center"
          toastOptions={{
            style: {
              background: 'var(--color-surface)',
              color: 'var(--color-ink)',
              border: 'none',
              boxShadow: 'var(--shadow-card), var(--rim-light)',
            },
          }}
        />
      </MotionConfig>
    </QueryClientProvider>
  );
}
