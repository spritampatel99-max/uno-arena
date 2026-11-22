// Card rendering. Faces are built from DOM + inline SVG so they stay crisp at any size.
import { h, s } from './dom.js';

export const COLORS = ['red', 'blue', 'yellow', 'green'];
export const COLOR_HEX = { red: '#FF414B', blue: '#287BFF', yellow: '#F9D83D', green: '#27C978' };
export const COLOR_NAME = { red: 'Red', blue: 'Blue', yellow: 'Yellow', green: 'Green' };

export function cardName(c) {
  if (!c) return 'card';
  const col = c.color ? COLOR_NAME[c.color] + ' ' : '';
  switch (c.kind) {
    case 'num': return col + c.value;
    case 'skip': return col + 'Skip';
    case 'reverse': return col + 'Reverse';
    case 'draw2': return col + 'Draw Two';
    case 'wild': return 'Wild';
    case 'wild4': return 'Wild Draw Four';
    default: return 'card';
  }
}

function svgBase(extra) {
  return s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', ...extra });
}

// Filled symbols so they read well at small sizes.
function symbol(kind) {
  if (kind === 'skip') {
    const svg = svgBase({ fill: 'none', stroke: 'currentColor', 'stroke-width': 3.2, 'stroke-linecap': 'round' });
    svg.append(s('circle', { cx: 12, cy: 12, r: 8.4 }), s('path', { d: 'M6.2 17.8 17.8 6.2' }));
    return svg;
  }
  if (kind === 'reverse') {
    const svg = svgBase({ fill: 'currentColor' });
    // two chunky arrows
    svg.append(
      s('path', { d: 'M4 10.5V9a3 3 0 0 1 3-3h7V3l6 5-6 5v-3H8v.5z' }),
      s('path', { d: 'M20 13.5V15a3 3 0 0 1-3 3h-7v3l-6-5 6-5v3h6v-.5z' }),
    );
    return svg;
  }
  return null;
}

function drawStack() {
  // two overlapping little cards (the "+2" figure is text next to it)
  const svg = svgBase({ viewBox: '0 0 40 40', fill: 'currentColor' });
  svg.append(
    s('rect', { x: 7, y: 6, width: 16, height: 22, rx: 3, transform: 'rotate(-12 15 17)', opacity: 0.55 }),
    s('rect', { x: 17, y: 10, width: 16, height: 22, rx: 3, transform: 'rotate(10 25 21)' }),
  );
  return svg;
}

function glyphFor(card) {
  switch (card.kind) {
    case 'num': return h('span', { class: 'num' + (card.value === 6 || card.value === 9 ? ' ul' : '') }, String(card.value));
    case 'skip': return symbol('skip');
    case 'reverse': return symbol('reverse');
    case 'draw2': return h('span', { class: 'plus' }, h('i', {}, drawStack('draw2')), h('b', {}, '+2'));
    case 'wild': return h('span', { class: 'wild-mark' });
    case 'wild4': return h('span', { class: 'plus wild4' }, h('b', {}, '+4'));
    default: return null;
  }
}

function indexFor(card) {
  switch (card.kind) {
    case 'num': return String(card.value);
    case 'draw2': return '+2';
    case 'wild4': return '+4';
    case 'skip': return symbol('skip');
    case 'reverse': return symbol('reverse');
    case 'wild': return h('span', { class: 'mini-wild' });
    default: return '';
  }
}

/** One distinct shape per colour, used by the colour-blind mode so colour is never the only cue. */
export function shapeSvg(color) {
  const svg = svgBase({ fill: 'currentColor' });
  if (color === 'red') svg.append(s('path', { d: 'M12 3 22 21H2z' }));
  else if (color === 'yellow') svg.append(s('rect', { x: 4, y: 4, width: 16, height: 16, rx: 2.5 }));
  else if (color === 'green') svg.append(s('path', { d: 'M12 2 22 12 12 22 2 12z' }));
  else if (color === 'blue') svg.append(s('circle', { cx: 12, cy: 12, r: 9 }));
  return svg;
}

export function cardEl(card, { size = 'hand', cls = '' } = {}) {
  const color = card.color || 'wild';
  const el = h('div', {
    class: `uno-card sz-${size} c-${color} k-${card.kind} ${cls}`.trim(),
    dataset: { id: card.id },
  },
  h('div', { class: 'face' },
    h('span', { class: 'idx tl' }, indexFor(card)),
    card.color ? h('i', { class: 'cb tr' }, shapeSvg(card.color)) : null,
    h('div', { class: 'oval' }, h('div', { class: 'glyph' }, glyphFor(card))),
    card.color ? h('i', { class: 'cb bl' }, shapeSvg(card.color)) : null,
    h('span', { class: 'idx br' }, indexFor(card))));
  return el;
}

/** `back` previews a specific skin (used by the Appearance panel); otherwise the player's chosen skin applies via CSS. */
export function backEl({ size = 'hand', cls = '', back = null } = {}) {
  return h('div', { class: `uno-card back sz-${size} ${cls}`.trim(), dataset: back ? { b: back } : null },
    h('div', { class: 'face' }, h('div', { class: 'oval' }, h('span', { class: 'logo-word' }, 'UNO'))));
}

/** Stable display order: colour groups, then number/symbol; wilds last. */
export function sortHand(cards, mode) {
  const colorRank = { red: 0, yellow: 1, green: 2, blue: 3 };
  const kindRank = { num: 0, skip: 10, reverse: 11, draw2: 12, wild: 20, wild4: 21 };
  const val = (c) => (c.kind === 'num' ? c.value : kindRank[c.kind]);
  const out = cards.slice();
  if (mode === 'number') {
    out.sort((a, b) => val(a) - val(b) || (colorRank[a.color] ?? 9) - (colorRank[b.color] ?? 9) || a.id - b.id);
  } else {
    out.sort((a, b) => (colorRank[a.color] ?? 9) - (colorRank[b.color] ?? 9) || val(a) - val(b) || a.id - b.id);
  }
  return out;
}
