// Full settings panel: sound, music, table theme, card back and play aids. Everything persists locally.
import { h } from './dom.js';
import { icon } from './icons.js';
import { openModal } from './ui.js';
import { audio } from './audio.js';
import { store, setPrefs } from './store.js';
import { THEMES, CARD_BACKS, CARD_STYLES } from './themes.js';
import { backEl } from './cards.js';
import { hapticsSupported, haptic } from './haptics.js';

function switchRow({ title, note, checked, onChange }) {
  const sw = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!checked), 'aria-label': title, onclick: () => {
    const next = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', String(next));
    onChange(next);
  } });
  return { sw, el: h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('b', {}, title), note ? h('span', {}, note) : null), sw) };
}

function sliderRow({ title, value, onInput, onCommit }) {
  const out = h('span', { class: 'mono set-val' }, `${Math.round(value * 100)}%`);
  const input = h('input', { class: 'range', type: 'range', min: 0, max: 100, step: 1, value: Math.round(value * 100), 'aria-label': title,
    oninput: () => { out.textContent = `${input.value}%`; onInput(Number(input.value) / 100); },
    onchange: () => onCommit && onCommit() });
  return h('div', { class: 'set-row slider' }, h('div', { class: 'set-text' }, h('b', {}, title)), h('div', { class: 'set-slider' }, input, out));
}

function section(ic, title, ...kids) {
  return h('section', { class: 'set-section' }, h('h3', {}, icon(ic), title), ...kids);
}

export function openSettings({ onGuide } = {}) {
  const fx = switchRow({ title: 'Sound effects', note: 'Card clanks and snaps, whooshes and chimes', checked: store.prefs.sound, onChange: (on) => audio.setEnabled(on) });
  const mu = switchRow({ title: 'Music', note: 'A slow ambient loop while you play', checked: store.prefs.music, onChange: (on) => audio.setMusic(on) });

  // Table theme + card back pickers (radio groups)
  const themeBtns = THEMES.map((t) => h('button', { class: 'swatch theme' + (store.prefs.theme === t.id ? ' sel' : ''), role: 'radio', 'aria-checked': String(store.prefs.theme === t.id), 'data-id': t.id,
    onclick: () => { setPrefs({ theme: t.id }); markGroup(themeBtns, t.id); audio.play('click'); } },
  h('span', { class: 'felt-mini', style: { background: `radial-gradient(ellipse at 50% 38%, ${t.swatch[0]}, ${t.swatch[1]} 78%)` } }),
  h('span', { class: 'sw-name' }, t.name), h('span', { class: 'sw-note' }, t.note)));
  const backBtns = CARD_BACKS.map((b) => h('button', { class: 'swatch back' + (store.prefs.cardBack === b.id ? ' sel' : ''), role: 'radio', 'aria-checked': String(store.prefs.cardBack === b.id), 'data-id': b.id,
    onclick: () => { setPrefs({ cardBack: b.id }); markGroup(backBtns, b.id); audio.play('flick'); } },
  h('span', { class: 'back-mini' }, backEl({ size: 'mini', back: b.id })),
  h('span', { class: 'sw-name' }, b.name)));
  const plate = (kind, color) => h('i', { class: `mat-plate ${kind} ${color}` }, h('i'));
  const styleBtns = CARD_STYLES.map((c) => h('button', { class: 'swatch material' + (store.prefs.cardStyle === c.id ? ' sel' : ''), role: 'radio', 'aria-checked': String(store.prefs.cardStyle === c.id), 'data-id': c.id,
    onclick: () => { setPrefs({ cardStyle: c.id }); markGroup(styleBtns, c.id); audio.play(c.id === 'metal' ? 'clank' : 'play'); } },
  h('span', { class: 'mat-mini' }, plate(c.id, 'r'), plate(c.id, 'b')),
  h('span', { class: 'sw-name' }, c.name), h('span', { class: 'sw-note' }, c.note)));
  function markGroup(btns, id) { for (const b of btns) { const on = b.dataset.id === id; b.classList.toggle('sel', on); b.setAttribute('aria-checked', String(on)); } }

  const cb = switchRow({ title: 'Colour-blind symbols', note: 'Adds a different shape to each card colour', checked: store.prefs.colorBlind, onChange: (on) => setPrefs({ colorBlind: on }) });
  const chatAlerts = switchRow({ title: 'Chat alerts', note: 'A small preview and a soft ping when someone writes', checked: store.prefs.chatAlerts, onChange: (on) => { setPrefs({ chatAlerts: on }); if (on) audio.play('chat'); } });
  const hints = switchRow({ title: 'Move hints', note: 'Marks a good card to play on your turn', checked: store.prefs.hints, onChange: (on) => { setPrefs({ hints: on }); if (on) audio.play('hint'); } });
  const vib = hapticsSupported() ? switchRow({ title: 'Vibration', note: 'A short buzz on your turn and big plays', checked: store.prefs.haptics, onChange: (on) => { setPrefs({ haptics: on }); if (on) haptic('turn'); } }) : null;
  const motion = switchRow({ title: 'Reduce motion', note: 'Skips dealing, flying cards and screen effects', checked: store.prefs.reduceMotion, onChange: (on) => setPrefs({ reduceMotion: on }) });

  const modal = openModal(h('div', { class: 'settings' },
    h('header', { class: 'set-head' },
      h('h2', {}, 'Settings'),
      h('button', { class: 'icon-btn', 'aria-label': 'Close settings', onclick: () => modal.close() }, icon('x'))),
    section('volume', 'Sound',
      fx.el,
      sliderRow({ title: 'Effects volume', value: store.prefs.volume, onInput: (v) => audio.setVolume(v), onCommit: () => audio.play('flick') }),
      mu.el,
      sliderRow({ title: 'Music volume', value: store.prefs.musicVolume, onInput: (v) => audio.setMusicVolume(v) }),
      h('p', { class: 'set-foot' }, 'Sound starts off every visit. Everything you hear is generated live in your browser.')),
    section('palette', 'Table',
      h('div', { class: 'set-label' }, 'Table theme'),
      h('div', { class: 'swatch-grid', role: 'radiogroup', 'aria-label': 'Table theme' }, themeBtns),
      h('div', { class: 'set-label' }, 'Card material'),
      h('div', { class: 'swatch-grid mats', role: 'radiogroup', 'aria-label': 'Card material' }, styleBtns),
      h('div', { class: 'set-label' }, 'Card back'),
      h('div', { class: 'swatch-grid backs', role: 'radiogroup', 'aria-label': 'Card back' }, backBtns)),
    section('eye', 'Play aids and comfort', cb.el, hints.el, chatAlerts.el, vib ? vib.el : null, motion.el),
    h('footer', { class: 'set-foot-row' },
      onGuide ? h('button', { class: 'btn ghost', onclick: () => { modal.close(); onGuide(); } }, icon('help'), 'How to play') : null,
      h('button', { class: 'btn', 'data-autofocus': '', onclick: () => modal.close() }, 'Done'))),
  { wide: true, label: 'Settings' });
  return modal;
}
