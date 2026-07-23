import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { MapPin, Search } from 'lucide-react';

import { AvailabilityView } from './components/AvailabilityView';
import { SearchView } from './components/SearchView';
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

type Tab = 'availability' | 'search';

const TABS: Array<{ id: Tab; label: string; icon: typeof MapPin }> = [
  { id: 'availability', label: 'In der Nähe', icon: MapPin },
  { id: 'search', label: 'Suche', icon: Search },
];

export default function App(): React.JSX.Element {
  // Availability answers the core "can I grab it right now?" question, so it
  // is the landing view (see docs/active/DELIVERY_MODEL_DECISION.md).
  const [tab, setTab] = useState<Tab>('availability');

  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <div className="mx-auto flex min-h-dvh max-w-2xl flex-col bg-zinc-50 pb-20 font-sans text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
          <header className="sticky top-0 z-30 flex h-[calc(env(safe-area-inset-top)+3.25rem)] items-center border-b border-zinc-200/70 bg-zinc-50/80 px-4 backdrop-blur-md dark:border-zinc-800/70 dark:bg-zinc-950/80">
            <h1 className="text-xl font-bold tracking-tight">
              Swiss <span className="text-blue-600">Shopping</span>
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
                {tab === 'availability' ? <AvailabilityView /> : <SearchView />}
              </motion.div>
            </AnimatePresence>
          </main>

          <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/90">
            <div className="mx-auto flex max-w-2xl pb-[env(safe-area-inset-bottom)]">
              {TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={cn(
                    'relative flex flex-1 flex-col items-center gap-1 py-2.5 text-xs font-medium transition-colors',
                    tab === id
                      ? 'text-blue-600'
                      : 'text-zinc-500 dark:text-zinc-400'
                  )}
                  aria-current={tab === id ? 'page' : undefined}
                >
                  {tab === id && (
                    <motion.span
                      layoutId="tab-indicator"
                      className="absolute inset-x-6 top-0 h-0.5 rounded-full bg-blue-600"
                    />
                  )}
                  <Icon className="size-5" />
                  {label}
                </button>
              ))}
            </div>
          </nav>
        </div>
      </MotionConfig>
    </QueryClientProvider>
  );
}
