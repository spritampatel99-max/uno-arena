// The practice table on the welcome screen: a tiny, local-only game of "match the top card".
// Nothing here touches the server. It exists so a first-time visitor learns the one rule that matters
// (match colour, number or symbol) by doing it, and so the first screen has something worth touching.
import { h, Disposer } from './dom.js';
import { cardEl, backEl, sortHand, cardName, COLOR_NAME, COLOR_HEX } from './cards.js';
import { fly, rectOf, shake } from './anim.js';
import { burst, sparks } from './fx.js';
import { audio } from './audio.js';
import { haptic } from './haptics.js';
import { reducedMotion, store } from './store.js';

const COLORS = ['red', 'blue', 'yellow', 'green'];
const HAND_SIZE = 6;
let nextId = 7000;
const rnd = (n) => Math.floor(Math.random() * n);

function makeCard(color = COLORS[rnd(4)], { plain = false } = {}) {
  const r = Math.random();
  if (plain || r < 0.7) return { id: nextId++, color, kind: 'num', value: rnd(10) };
  if (r < 0.79) return { id: nextId++, color, kind: 'skip', value: null };
  if (r < 0.88) return { id: nextId++, color, kind: 'reverse', value: null };
  if (r < 0.95) return { id: nextId++, color, kind: 'draw2', value: null };
  return { id: nextId++, color: null, kind: 'wild', value: null };
}

export function createHeroTable() {
  const d = new Disposer();
  let top = makeCard(COLORS[rnd(4)], { plain: true });
  let color = top.color;
  let trail = [top];
  let hand = [];
  let plays = 0;
  let busy = false;
  const nodes = new Map();

  const matches = (c) => !c.color || c.color === color || (c.kind === 'num' && top.kind === 'num' && c.value === top.value) || (c.kind !== 'num' && c.kind === top.kind);

  // opening hand: a mix, always with a few cards that fit the starter
  const seed = [makeCard(color, { plain: true }), makeCard(color), makeCard(COLORS[rnd(4)]), makeCard(COLORS[rnd(4)]), makeCard(COLORS[rnd(4)]), makeCard(COLORS[rnd(4)], { plain: true })];
  hand = sortHand(seed, 'colour');

  // ---- DOM
  const colorDot = h('i', { class: 'color-dot ' + color });
  const colorText = h('span', {}, COLOR_NAME[color]);
  const colorChip = h('span', { class: 'chip ht-color', title: 'The colour to match' }, colorDot, colorText);
  const discardSlot = h('div', { class: 'ht-discard' });
  const glow = h('div', { class: 'ht-glow' });
  const drawPile = h('div', { class: 'ht-draw', 'aria-hidden': 'true' }, backEl({ size: 'hero', cls: 'p3' }), backEl({ size: 'hero', cls: 'p2' }), backEl({ size: 'hero', cls: 'p1' }));
  const piles = h('div', { class: 'ht-piles' }, drawPile, h('div', { class: 'ht-top' }, glow, discardSlot));
  const felt = h('div', { class: 'ht-felt', 'aria-hidden': 'true' }, h('i', { class: 'ht-ring' }));
  const handEl = h('div', { class: 'ht-hand', role: 'group', 'aria-label': 'Your practice hand' });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const caption = h('p', { class: 'ht-cap' }, 'Tap a glowing card to play it.');
  const scene = h('div', { class: 'ht-scene' }, felt, colorChip, piles, handEl);
  const el = h('div', { class: 'ht', 'data-color': color }, scene, caption, live);

  // ---- rendering
  function paintDiscard() {
    discardSlot.textContent = '';
    trail.slice(-3).forEach((c) => {
      const e = cardEl(c, { size: 'hero' });
      const rot = ((c.id * 37) % 21) - 10;
      const ox = ((c.id * 13) % 11) - 5;
      e.style.transform = `translate(${ox}px, ${((c.id * 29) % 9) - 4}px) rotate(${rot}deg)`;
      discardSlot.append(e);
    });
    el.dataset.color = color;
    colorDot.className = 'color-dot ' + color;
    colorText.textContent = COLOR_NAME[color];
  }

  function makeNode(card) {
    const b = h('button', { class: 'ht-card', type: 'button', dataset: { id: card.id }, onclick: () => tryPlay(card, b) }, cardEl(card, { size: 'hero' }));
    nodes.set(card.id, b);
    handEl.append(b);
    return b;
  }

  function layout() {
    const n = hand.length;
    hand.forEach((c, i) => {
      const b = nodes.get(c.id);
      const t = i - (n - 1) / 2;
      const ok = matches(c);
      b.style.setProperty('--x', `${t * 11}%`);
      b.style.setProperty('--y', `${Math.abs(t) * Math.abs(t) * 1.3}%`);
      b.style.setProperty('--r', `${t * 7}deg`);
      b.style.zIndex = String(i + 1);
      b.classList.toggle('ok', ok);
      b.classList.toggle('dim', !ok);
      b.setAttribute('aria-label', `${cardName(c)}${ok ? ', playable' : ', does not match'}`);
    });
  }

  function arrive(node, { delay = 0, from = null } = {}) {
    if (reducedMotion() || !node.animate) return;
    const a = from || rectOf(drawPile);
    const b = rectOf(node.querySelector('.uno-card'));
    const dx = a.cx - b.cx; const dy = a.cy - b.cy;
    node.animate([
      { translate: `${dx}px ${dy}px`, scale: '0.55', opacity: 0 },
      { translate: '0 0', scale: '1', opacity: 1 },
    ], { duration: 520, delay, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' });
  }

  // ---- play
  function bestColor(rest) {
    const count = Object.fromEntries(COLORS.map((c) => [c, 0]));
    for (const c of rest) if (c.color) count[c.color]++;
    return COLORS.slice().sort((a, b) => count[b] - count[a])[0];
  }

  function say(text) { live.textContent = text; }

  async function tryPlay(card, node) {
    if (busy) return;
    if (!matches(card)) {
      shake(node);
      audio.play('error');
      caption.textContent = `That one is ${card.color ? COLOR_NAME[card.color].toLowerCase() : 'a wild'}. Match the colour, number or symbol.`;
      say(caption.textContent);
      return;
    }
    busy = true;
    const from = rectOf(node.querySelector('.uno-card'));
    const ghost = cardEl(card, { size: 'hero' });
    const slotRect = rectOf(discardSlot);
    ghost.style.setProperty('--cw', slotRect.w + 'px');
    node.classList.add('gone');
    hand = hand.filter((c) => c !== card);
    audio.play('play'); haptic('tap');
    await fly(ghost, from, slotRect, { duration: 360, rotateTo: ((card.id * 37) % 21) - 10 });
    audio.land(card);
    top = card;
    trail.push(card);
    color = card.color || bestColor(hand);
    nodes.delete(card.id); node.remove();
    plays++;
    paintDiscard();
    const r = rectOf(discardSlot);
    burst(r.cx, r.cy, COLOR_HEX[color], card.kind === 'num' ? 14 : 28);
    if (store.prefs.cardStyle === 'metal') {
      sparks(r.cx, r.cy, card.kind === 'num' ? 10 : 18);
      const topEl = discardSlot.lastElementChild;
      if (topEl) topEl.classList.add('glint');
    }
    if (card.kind === 'wild') audio.play('color');
    // top the hand back up so there is always something to play
    const fresh = makeCard(hand.some(matches) ? undefined : color, { plain: !hand.some(matches) });
    hand = sortHand([...hand, fresh], 'colour');
    const node2 = makeNode(fresh);
    layout();
    arrive(node2);
    audio.play('draw');
    const msg = plays >= 5
      ? 'That is the whole game. Create a room to play for real.'
      : card.color ? `Colour is ${COLOR_NAME[color].toLowerCase()}. Match it, or match the ${top.kind === 'num' ? 'number' : 'symbol'}.` : `You chose ${COLOR_NAME[color].toLowerCase()}. Keep going.`;
    caption.textContent = msg;
    say(`Played ${cardName(card)}. ${msg}`);
    busy = false;
  }

  // ---- pointer depth (mouse only; skipped with reduced motion)
  let raf = 0; let tx = 0; let ty = 0;
  const applyTilt = () => { raf = 0; el.style.setProperty('--tx', tx.toFixed(3)); el.style.setProperty('--ty', ty.toFixed(3)); };
  const onMove = (e) => {
    if (e.pointerType !== 'mouse' || reducedMotion()) return;
    const r = el.getBoundingClientRect();
    tx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width - 0.5) * 2));
    ty = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height - 0.5) * 2));
    if (!raf) raf = requestAnimationFrame(applyTilt);
  };
  const onLeave = () => { tx = 0; ty = 0; if (!raf) raf = requestAnimationFrame(applyTilt); };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerleave', onLeave);
  d.add(() => { el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerleave', onLeave); cancelAnimationFrame(raf); });

  // initial paint
  paintDiscard();
  hand.forEach((c) => makeNode(c));
  layout();

  return {
    el,
    mount() {
      // deal the opening hand in from the draw pile
      requestAnimationFrame(() => hand.forEach((c, i) => arrive(nodes.get(c.id), { delay: 260 + i * 85 })));
    },
    unmount() { d.dispose(); },
  };
}
