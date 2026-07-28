/**
 * Best-effort "search finished" notification for when the user has
 * backgrounded the installed PWA. Real Notification API only — no fake
 * fallback — so it only fires if permission was actually granted, and it
 * never throws into the caller's search flow on failure.
 *
 * Scope: this covers the app being backgrounded but still alive (the common
 * "left the PWA to check something else" case). It cannot notify after the
 * OS fully kills/swipes-away the app, which would need real Web Push
 * (VAPID keys + a backend subscription store) — a materially bigger
 * undertaking than this pass, intentionally not built here.
 */

const ICON_PATH = '/app/pwa-192.png';

/** Call from a user-gesture handler (e.g. a search submit) — browsers require one to prompt. */
export async function requestNotificationPermissionIfNeeded(): Promise<void> {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'default') return;
  try {
    await Notification.requestPermission();
  } catch {
    // User dismissed, or the browser blocked the prompt — not actionable here.
  }
}

export async function notifyIfBackgrounded(title: string, body: string): Promise<void> {
  if (!('Notification' in window)) return;
  if (document.visibilityState !== 'hidden') return;
  if (Notification.permission !== 'granted') return;

  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(title, { body, icon: ICON_PATH, tag: 'search-complete' });
      return;
    }
    new Notification(title, { body, icon: ICON_PATH });
  } catch {
    // Best-effort — a notification failure must never break the search flow.
  }
}
