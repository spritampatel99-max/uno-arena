// "Install app" support. The browser decides when an install is possible and fires beforeinstallprompt;
// this module keeps that event so any screen can offer an Install button, and registers the offline cache.
const listeners = new Set();
let deferred = null;

const notify = () => listeners.forEach((fn) => { try { fn(); } catch (_) { /* a stale listener must not break the others */ } });

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; notify(); });
  window.addEventListener('appinstalled', () => { deferred = null; notify(); });
}

export const canInstall = () => !!deferred;
export const isStandalone = () => typeof window !== 'undefined' && ((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true);

/** Subscribe to install availability changes. Returns an unsubscribe function. */
export function onInstallChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Shows the browser's install dialog. Resolves true when the player accepted. */
export async function promptInstall() {
  if (!deferred) return false;
  const ev = deferred;
  deferred = null;
  notify();
  try {
    await ev.prompt();
    const choice = await ev.userChoice;
    return choice && choice.outcome === 'accepted';
  } catch (_) { return false; }
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell is a bonus, never required */ }); });
}
