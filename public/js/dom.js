// Tiny DOM helpers. Text is always inserted as text nodes (never innerHTML) so player names cannot inject markup.

const SVG_NS = 'http://www.w3.org/2000/svg';

function applyProps(el, props) {
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class' || key === 'className') el.setAttribute('class', Array.isArray(value) ? value.filter(Boolean).join(' ') : value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'ref' && typeof value === 'function') value(el);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
}

function append(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, kids);
  return el;
}

export function s(tag, props, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(props || {})) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  append(el, kids);
  return el;
}

/** Parse a trusted, static SVG/HTML string (never player-controlled). */
export function fromHTML(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function setText(el, text) {
  const t = String(text);
  if (el.textContent !== t) el.textContent = t;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function raf() { return new Promise((r) => requestAnimationFrame(() => r())); }

export function cx(...parts) { return parts.filter(Boolean).join(' '); }

/** Simple disposer collection so screens can clean up listeners/timers on unmount. */
export class Disposer {
  constructor() { this.fns = []; }
  add(fn) { this.fns.push(fn); return fn; }
  on(target, type, handler, opts) {
    target.addEventListener(type, handler, opts);
    this.fns.push(() => target.removeEventListener(type, handler, opts));
  }
  timeout(fn, ms) { const id = setTimeout(fn, ms); this.fns.push(() => clearTimeout(id)); return id; }
  interval(fn, ms) { const id = setInterval(fn, ms); this.fns.push(() => clearInterval(id)); return id; }
  dispose() { for (const fn of this.fns.splice(0)) { try { fn(); } catch (_) { /* ignore */ } } }
}
