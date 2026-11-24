// Interface scale. Every pixel length in the stylesheets is written as calc(Npx * var(--s)), so the whole UI grows
// with one number: 1 up to a 1920x1080 window, rising smoothly to 2 at 3840x2160 (a 4K screen at 100% scaling).
// Layouts that depend on the window size therefore behave exactly as they do on a 1080p screen, only larger.
const DESIGN_W = 1920;
const DESIGN_H = 1080;
const MAX = 2;

let current = 1;
const listeners = new Set();

export function computeScale(w = window.innerWidth, h = window.innerHeight) {
  const s = Math.min(w / DESIGN_W, h / DESIGN_H);
  return Math.round(Math.max(1, Math.min(MAX, s)) * 100) / 100;
}

/** The scale currently applied (1 on phones, laptops and 1080p screens). */
export const uiScale = () => current;

/** Run fn whenever the scale changes (the arena uses it to re-measure its cards). */
export function onScale(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function apply() {
  const s = computeScale();
  if (s === current && document.documentElement.style.getPropertyValue('--s')) return;
  current = s;
  document.documentElement.style.setProperty('--s', String(s));
  document.documentElement.dataset.scale = s > 1 ? 'large' : 'normal';
  for (const fn of listeners) { try { fn(s); } catch (e) { console.error(e); } }
}

export function initScale() {
  apply();
  window.addEventListener('resize', apply);
}
