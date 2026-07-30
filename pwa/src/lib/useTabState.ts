import { useCallback, useEffect, useState } from 'react';

/**
 * Active-tab state mirrored into the URL's `?tab=` query param.
 *
 * Plain `useState` loses the active tab on every reload, always dumping the
 * user back on the first tab and discarding whatever they were looking at —
 * reported as annoying both on a normal refresh and on the reload that
 * "Unterhaltung löschen" used to trigger.
 *
 * Mirroring into history (rather than sessionStorage) additionally makes the
 * Android back button walk back through visited tabs instead of closing an
 * installed PWA outright, which is the platform-expected behaviour.
 */
export function useTabState<T extends string>(
  tabs: readonly T[],
  fallback: T
): [T, (next: T) => void] {
  const readFromUrl = useCallback((): T => {
    const value = new URLSearchParams(window.location.search).get('tab');
    return tabs.includes(value as T) ? (value as T) : fallback;
  }, [tabs, fallback]);

  const [tab, setTabState] = useState<T>(readFromUrl);

  useEffect(() => {
    function handlePopState(): void {
      setTabState(readFromUrl());
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [readFromUrl]);

  const setTab = useCallback((next: T): void => {
    setTabState(next);
    // Guarding on the URL rather than on `tab` keeps this idempotent under
    // StrictMode's double-invocation and avoids stacking duplicate history
    // entries when the same tab is tapped twice.
    const url = new URL(window.location.href);
    if (url.searchParams.get('tab') === next) return;
    url.searchParams.set('tab', next);
    window.history.pushState(null, '', url);
  }, []);

  return [tab, setTab];
}
