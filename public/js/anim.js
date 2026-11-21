// Animation helpers built on the Web Animations API.
import { reducedMotion } from './store.js';

export function layer() { return document.getElementById('flight-layer'); }

export function rectOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
}

/**
 * Fly a ghost element between two screen rects.
 * `ghost` must be a fully styled element; it is positioned fixed in the flight layer and removed afterwards.
 */
export function fly(ghost, from, to, { duration = 420, rotateFrom = 0, rotateTo = 0, easing = 'cubic-bezier(.22,1,.36,1)', delay = 0, keep = false } = {}) {
  const host = layer();
  if (!host || reducedMotion()) { return Promise.resolve(); }
  Object.assign(ghost.style, { position: 'fixed', left: '0px', top: '0px', margin: '0', zIndex: '55', pointerEvents: 'none', willChange: 'transform', visibility: 'hidden' });
  host.append(ghost);
  // The ghost keeps its natural size; scale maps that size onto the start and end rectangles.
  const gw = ghost.offsetWidth || from.w || 1;
  const gh = ghost.offsetHeight || from.h || 1;
  ghost.style.visibility = '';
  const t = (r, rot) => `translate(${r.cx - gw / 2}px, ${r.cy - gh / 2}px) rotate(${rot}deg) scale(${(r.w || gw) / gw}, ${(r.h || gh) / gh})`;
  const a = ghost.animate([
    { transform: t(from, rotateFrom), opacity: 0.96 },
    { transform: t(to, rotateTo), opacity: 1 },
  ], { duration, easing, delay, fill: 'both' });
  return a.finished.catch(() => {}).then(() => { if (!keep) ghost.remove(); });
}

export function shake(el) {
  if (!el || reducedMotion()) return;
  el.animate([
    { transform: 'translateX(0)' }, { transform: 'translateX(-7px)' }, { transform: 'translateX(6px)' },
    { transform: 'translateX(-4px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(0)' },
  ], { duration: 320, easing: 'ease-out' });
}

export function popIn(el, { duration = 520, from = 0.6 } = {}) {
  if (!el || reducedMotion()) return;
  el.animate([
    { opacity: 0, transform: `scale(${from})` }, { opacity: 1, transform: 'scale(1.08)', offset: 0.6 }, { opacity: 1, transform: 'scale(1)' },
  ], { duration, easing: 'cubic-bezier(.34,1.56,.64,1)' });
}

export function pulse(el) {
  if (!el || reducedMotion()) return;
  el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 380, easing: 'ease-out' });
}
