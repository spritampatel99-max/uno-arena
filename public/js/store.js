// Minimal reactive store + safe persistence helpers.
import { THEME_IDS, BACK_IDS, STYLE_IDS } from './themes.js';

function safeGet(storage, key) {
  try { return JSON.parse(storage.getItem(key)); } catch (_) { return null; }
}
function safeSet(storage, key, value) {
  try { if (value === null || value === undefined) storage.removeItem(key); else storage.setItem(key, JSON.stringify(value)); } catch (_) { /* storage may be blocked */ }
}

// sound and music are never persisted as "on": audio must always start disabled and needs a user gesture.
const DEFAULT_PREFS = {
  sound: false, music: false, volume: 0.6, musicVolume: 0.35,
  reduceMotion: false, theme: 'midnight', cardBack: 'classic', cardStyle: 'metal', colorBlind: false, haptics: true, hints: false,
};
const PERSISTED = ['volume', 'musicVolume', 'reduceMotion', 'theme', 'cardBack', 'cardStyle', 'colorBlind', 'haptics', 'hints'];

function sanitizePrefs(p) {
  const out = { ...DEFAULT_PREFS, ...(p || {}), sound: false, music: false };
  if (!THEME_IDS.includes(out.theme)) out.theme = DEFAULT_PREFS.theme;
  if (!BACK_IDS.includes(out.cardBack)) out.cardBack = DEFAULT_PREFS.cardBack;
  if (!STYLE_IDS.includes(out.cardStyle)) out.cardStyle = DEFAULT_PREFS.cardStyle;
  for (const k of ['volume', 'musicVolume']) {
    const n = Number(out[k]);
    out[k] = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_PREFS[k];
  }
  for (const k of ['reduceMotion', 'colorBlind', 'haptics', 'hints']) out[k] = !!out[k];
  return out;
}

export const store = {
  session: safeGet(sessionStorage, 'uno.session'),   // { code, pid, token } — survives refresh, not a new tab
  profile: safeGet(localStorage, 'uno.profile') || { name: '', avatar: 'fox' },
  prefs: sanitizePrefs(safeGet(localStorage, 'uno.prefs')),
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

/** Reflect appearance prefs onto the document so CSS can react to them. */
export function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme = store.prefs.theme;
  root.dataset.back = store.prefs.cardBack;
  root.dataset.cards = store.prefs.cardStyle;
  document.body.classList.toggle('reduce-motion', !!store.prefs.reduceMotion);
  document.body.classList.toggle('cb', !!store.prefs.colorBlind);
}

export function setPrefs(patch = {}) {
  // sound/music are live-only flags: sanitizePrefs() forces them off, so carry the session values across by hand
  const sound = 'sound' in patch ? !!patch.sound : store.prefs.sound;
  const music = 'music' in patch ? !!patch.music : store.prefs.music;
  store.prefs = { ...sanitizePrefs({ ...store.prefs, ...patch }), sound, music };
  const persisted = {};
  for (const k of PERSISTED) persisted[k] = store.prefs[k];
  safeSet(localStorage, 'uno.prefs', persisted);
  applyAppearance();
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
