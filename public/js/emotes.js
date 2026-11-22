// Quick reactions: the picker button for the player's own bar and the speech bubbles everyone sees.
// The list must match EMOTES in server/rooms.js; the server rejects anything else.
import { h } from './dom.js';
import { icon } from './icons.js';

export const EMOTES = [
  { id: 'gg', label: 'GG', icon: 'party' },
  { id: 'nice', label: 'Nice!', icon: 'thumbsUp' },
  { id: 'wow', label: 'Wow', icon: 'wow' },
  { id: 'haha', label: 'Haha', icon: 'laugh' },
  { id: 'thanks', label: 'Thanks', icon: 'smile' },
  { id: 'think', label: 'Hmm…', icon: 'bulb' },
  { id: 'fire', label: 'On fire', icon: 'flame' },
  { id: 'great', label: 'Great play', icon: 'star' },
];
export const emoteById = (id) => EMOTES.find((e) => e.id === id) || null;

/**
 * The reaction button plus its popover.
 * @param {{ onPick: (id: string) => void, cooldownMs?: number }} opts
 */
export function emoteButton({ onPick, cooldownMs = 800 }) {
  const btn = h('button', { class: 'icon-btn emote-btn', 'aria-label': 'Send a reaction', 'aria-haspopup': 'true', 'aria-expanded': 'false', title: 'Reactions (E)' }, icon('smile'));
  const wrap = h('div', { class: 'emote-wrap' }, btn);
  let pop = null;

  const outside = (e) => { if (pop && !wrap.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape' && pop) { e.stopPropagation(); close(); btn.focus(); } };

  function close() {
    if (!pop) return;
    pop.remove(); pop = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function open() {
    if (pop || btn.disabled) return;
    pop = h('div', { class: 'emote-pop', role: 'menu', 'aria-label': 'Reactions' },
      EMOTES.map((em) => h('button', { class: 'emote-opt', role: 'menuitem', 'aria-label': em.label, onclick: () => pick(em.id) }, icon(em.icon), h('span', {}, em.label))));
    wrap.append(pop);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
    const first = pop.querySelector('button');
    if (first) first.focus();
  }

  function pick(id) {
    close();
    btn.disabled = true;
    btn.classList.add('cool');
    setTimeout(() => { btn.disabled = false; btn.classList.remove('cool'); }, cooldownMs);
    onPick(id);
    btn.focus();
  }

  btn.addEventListener('click', () => (pop ? close() : open()));
  return { el: wrap, button: btn, open, close, toggle: () => (pop ? close() : open()), isOpen: () => !!pop };
}

/** A speech bubble. Text is set with text nodes only, so a player name can never inject markup. */
export function emoteBubble(emote, { name = '', mine = false } = {}) {
  return h('div', { class: 'emote-bubble' + (mine ? ' mine' : ''), role: 'img', 'aria-label': `${name} says ${emote.label}` },
    h('span', { class: 'eb-ic' }, icon(emote.icon)),
    h('span', { class: 'eb-text' }, h('b', {}, emote.label), name ? h('i', {}, name) : null));
}
