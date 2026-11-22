// Full-table "moments": the big, short flourishes for +2/+4, skip, reverse, a colour change and UNO.
// They are pure decoration layered over the arena. The game never waits for them, they never take clicks,
// and with reduced motion switched on show() returns false so the caller falls back to a plain banner.
import { h } from './dom.js';
import { icon } from './icons.js';
import { shapeSvg, COLOR_NAME } from './cards.js';
import { reducedMotion } from './store.js';

const CLEAN_UP_MS = { draw: 1250, skip: 1250, reverse: 1250, color: 1500, uno: 1350 };

/**
 * @param {HTMLElement} layer   absolutely positioned, pointer-events: none, fills the arena
 * @param {() => ({cx:number, cy:number} | null)} origin  screen centre of the table
 * @param {(kind: string) => void} [onHit]  called when something should shake the stage
 */
export function createMoments(layer, origin, onHit) {
  let busyUntil = 0;

  function place(node) {
    const a = layer.getBoundingClientRect();
    const o = origin();
    node.style.setProperty('--ox', (o ? o.cx - a.left : a.width / 2) + 'px');
    node.style.setProperty('--oy', (o ? o.cy - a.top : a.height / 2) + 'px');
  }

  function mount(kind, color, kids) {
    const node = h('div', { class: `moment m-${kind}`, 'data-c': color || 'none' }, ...kids);
    place(node);
    layer.append(node);
    setTimeout(() => node.remove(), CLEAN_UP_MS[kind] || 1300);
    return node;
  }

  const ring = (extra = '') => h('i', { class: 'm-ring ' + extra });
  const label = (text) => (text ? h('span', { class: 'm-sub' }, text) : null);

  const builders = {
    // +2 / +4 (and stacked totals): a flash, a shock ring and a numeral that slams onto the table
    draw: ({ amount = 2, color = null, wild = false, who = '' }) => {
      if (onHit) onHit('draw');
      return mount('draw', wild ? 'wild' : color, [
        h('i', { class: 'm-flash' }), ring(), ring('r2'),
        h('div', { class: 'm-core' }, h('b', { class: 'm-big' }, `+${amount}`), label(who))]);
    },
    skip: ({ who = '' }) => mount('skip', 'red', [
      h('i', { class: 'm-flash' }), ring(),
      h('div', { class: 'm-core' }, h('span', { class: 'm-stamp' }, icon('ban')), h('b', { class: 'm-word' }, 'Skipped'), label(who))]),
    reverse: ({ ccw = false }) => mount('reverse', 'blue', [
      h('i', { class: 'm-flash' }), ring(),
      h('div', { class: 'm-core' }, h('span', { class: 'm-spin' + (ccw ? ' ccw' : '') }, icon('repeat')), h('b', { class: 'm-word' }, 'Reverse'), label(ccw ? 'Counter-clockwise' : 'Clockwise'))]),
    // a colour wheel spins up and settles on the chosen colour (with its shape when colour-blind mode is on)
    color: ({ color }) => mount('color', color, [
      h('i', { class: 'm-flash' }), ring(),
      h('div', { class: 'm-core' },
        h('span', { class: 'm-wheel' }),
        h('span', { class: 'm-disc' }, h('i', { class: 'cb-shape' }, shapeSvg(color))),
        h('b', { class: 'm-word' }, COLOR_NAME[color] || ''))]),
    uno: ({ who = '' }) => mount('uno', 'yellow', [
      h('i', { class: 'm-flash' }), ring(), ring('r2'),
      h('div', { class: 'm-core' }, h('b', { class: 'm-uno-word' }, 'UNO!'), label(who))]),
  };

  return {
    /** Returns true when a moment was shown, false when it was skipped (reduced motion or another one is playing). */
    show(kind, opts = {}) {
      if (reducedMotion() || !builders[kind]) return false;
      const now = performance.now();
      if (now < busyUntil && !opts.force) return false;
      busyUntil = now + 800;
      builders[kind](opts);
      return true;
    },
    /** Like show(), but if another moment is still playing it waits for it to finish instead of giving up. */
    showSoon(kind, opts = {}) {
      if (reducedMotion() || !builders[kind]) return false;
      const wait = busyUntil - performance.now();
      if (wait <= 0) return this.show(kind, opts);
      setTimeout(() => { if (!reducedMotion()) this.show(kind, { ...opts, force: true }); }, wait + 60);
      return true;
    },
    clear() { for (const n of [...layer.children]) n.remove(); busyUntil = 0; },
  };
}
