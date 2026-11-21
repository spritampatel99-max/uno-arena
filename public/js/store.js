// Minimal reactive store + safe persistence helpers.

function safeGet(storage, key) {
  try { return JSON.parse(storage.getItem(key)); } catch (_) { return null; }
}
function safeSet(storage, key, value) {
  try { if (value === null || value === undefined) storage.removeItem(key); else storage.setItem(key, JSON.stringify(value)); } catch (_) { /* storage may be blocked */ }
}

const DEFAULT_PREFS = { sound: false, volume: 0.6, reduceMotion: false };

export const store = {
  session: safeGet(sessionStorage, 'uno.session'),   // { code, pid, token } — survives refresh, not a new tab
  profile: safeGet(localStorage, 'uno.profile') || { name: '', avatar: 'fox' },
  prefs: { ...DEFAULT_PREFS, ...(safeGet(localStorage, 'uno.prefs') || {}), sound: false }, // sound always starts disabled
  state: null,          // latest per-player room view from the server
  conn: 'idle',         // idle | connecting | online | reconnecting
  offset: 0,            // serverTime - Date.now()
  listeners: new Set(),
};

export function subscribe(fn) {
  store.listeners.add(fn);
  return () => store.listeners.delete(fn);
}

function emit(keys) { for (const fn of [...store.listeners]) fn(keys); }

export function setSession(session) {
  store.session = session;
  safeSet(sessionStorage, 'uno.session', session);
  emit(['session']);
}

export function setProfile(patch) {
  store.profile = { ...store.profile, ...patch };
  safeSet(localStorage, 'uno.profile', store.profile);
  emit(['profile']);
}

export function setPrefs(patch) {
  store.prefs = { ...store.prefs, ...patch };
  safeSet(localStorage, 'uno.prefs', { volume: store.prefs.volume, reduceMotion: store.prefs.reduceMotion, sound: false });
  document.body.classList.toggle('reduce-motion', !!store.prefs.reduceMotion);
  emit(['prefs']);
}

export function setConn(conn) {
  if (store.conn === conn) return;
  store.conn = conn;
  emit(['conn']);
}

export function setState(state, serverTime) {
  store.state = state;
  if (serverTime) store.offset = serverTime - Date.now();
  emit(['state']);
}

export function clearRoom() {
  store.state = null;
  setSession(null);
  emit(['state']);
}

export const serverNow = () => Date.now() + store.offset;

export function reducedMotion() {
  return !!store.prefs.reduceMotion || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}
