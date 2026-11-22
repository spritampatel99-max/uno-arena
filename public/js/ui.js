// Shared UI pieces: toasts, modals, sound control, avatar picker, clipboard/share helpers.
import { h, clear, $ } from './dom.js';
import { icon } from './icons.js';
import { avatar, AVATAR_IDS, AVATAR_LABEL } from './avatars.js';
import { audio } from './audio.js';
import { store, subscribe } from './store.js';

// ------------------------------------------------------------------ toast
export function toast(message, kind = 'info', ms = 3200) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const ic = kind === 'error' ? 'alert' : kind === 'good' ? 'check' : 'info';
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, icon(ic), h('span', {}, message));
  // keep the stack short
  while (root.children.length >= 3) root.firstElementChild.remove();
  root.append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
}

// ------------------------------------------------------------------ modal
let modalStack = [];

export function openModal(content, { wide = false, dismissable = true, onClose, label } = {}) {
  const root = document.getElementById('overlay-root');
  const prevFocus = document.activeElement;
  const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': label || null, tabindex: '-1' }, content);
  const backdrop = h('div', { class: 'modal-backdrop' }, box);
  let closed = false;
  const api = {
    el: box,
    close(result) {
      if (closed) return;
      closed = true;
      modalStack = modalStack.filter((m) => m !== api);
      document.removeEventListener('keydown', onKey, true);
      backdrop.classList.add('closing');
      setTimeout(() => backdrop.remove(), 170);
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }
      if (onClose) onClose(result);
    },
  };
  const onKey = (e) => {
    if (modalStack[modalStack.length - 1] !== api) return;
    if (e.key === 'Escape' && dismissable) { e.stopPropagation(); api.close('dismiss'); }
    if (e.key === 'Tab') {
      const f = [...box.querySelectorAll('button:not(:disabled), input, [tabindex="0"]')].filter((n) => n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  if (dismissable) backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) api.close('dismiss'); });
  modalStack.push(api);
  root.append(backdrop);
  setTimeout(() => { const f = box.querySelector('[data-autofocus]') || box.querySelector('button, input'); (f || box).focus({ preventScroll: true }); }, 30);
  return api;
}

export function confirmModal({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let m;
    const done = (v) => { resolve(v); m.close(); };
    m = openModal([
      h('h2', {}, title),
      h('p', {}, body),
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost', 'data-autofocus': '', onclick: () => done(false) }, cancelLabel),
        h('button', { class: 'btn ' + (danger ? 'red' : ''), onclick: () => done(true) }, confirmLabel)),
    ], { onClose: (r) => { if (r === 'dismiss') resolve(false); } });
  });
}

export function closeAllModals() { for (const m of [...modalStack]) m.close('dismiss'); }

// ------------------------------------------------------------------ how-to-play (loaded on demand)
export async function openGuide() { const m = await import('./guide.js'); return m.openGuide(); }

// ------------------------------------------------------------------ sound control (quick popover; full panel in settings.js)
export function soundControl() {
  const btn = h('button', { class: 'icon-btn', 'aria-label': 'Sound and settings', 'aria-haspopup': 'true', 'aria-expanded': 'false' });
  const wrap = h('div', { class: 'sound' }, btn);
  let pop = null;

  const paint = () => {
    clear(btn);
    const live = store.prefs.sound || store.prefs.music;
    btn.append(icon(live ? 'volume' : 'mute'));
    btn.classList.toggle('on', live);
  };

  const close = () => { if (pop) { pop.remove(); pop = null; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); } };
  const outside = (e) => { if (pop && !wrap.contains(e.target)) close(); };

  const open = () => {
    const mk = (label, key, fn) => {
      const sw = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!store.prefs[key]), 'aria-label': label, onclick: () => {
        fn(!store.prefs[key]);
        sw.setAttribute('aria-checked', String(!!store.prefs[key]));
        paint();
      } });
      return h('div', { class: 'row' }, h('span', {}, label), sw);
    };
    const vol = h('input', { class: 'range', type: 'range', min: 0, max: 100, step: 1, value: Math.round(store.prefs.volume * 100), 'aria-label': 'Effects volume',
      oninput: () => audio.setVolume(Number(vol.value) / 100), onchange: () => audio.play('flick') });
    const mvol = h('input', { class: 'range', type: 'range', min: 0, max: 100, step: 1, value: Math.round(store.prefs.musicVolume * 100), 'aria-label': 'Music volume',
      oninput: () => audio.setMusicVolume(Number(mvol.value) / 100) });
    const more = h('button', { class: 'pop-link', onclick: async () => { close(); const m = await import('./settings.js'); m.openSettings({ onGuide: openGuide }); } }, icon('gear'), 'All settings');
    pop = h('div', { class: 'sound-pop', role: 'group', 'aria-label': 'Sound' },
      mk('Sound effects', 'sound', (on) => audio.setEnabled(on)),
      h('div', { class: 'pop-slider' }, vol),
      mk('Music', 'music', (on) => audio.setMusic(on)),
      h('div', { class: 'pop-slider' }, mvol),
      h('div', { class: 'pop-links' }, more, h('button', { class: 'pop-link', onclick: () => { close(); openGuide(); } }, icon('help'), 'How to play')));
    wrap.append(pop);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
  };

  btn.addEventListener('click', () => { if (pop) close(); else open(); });
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  const unsub = subscribe((keys) => { if (keys.includes('prefs')) paint(); });
  wrap.dispose = () => { unsub(); close(); };
  paint();
  return wrap;
}

// ------------------------------------------------------------------ avatar picker
export function avatarPicker({ value, onPick, size = 64 }) {
  const grid = h('div', { class: 'avatar-grid', role: 'radiogroup', 'aria-label': 'Choose an avatar' });
  const paint = (cur) => {
    clear(grid);
    for (const id of AVATAR_IDS) {
      grid.append(h('button', { class: 'avatar-opt' + (id === cur ? ' sel' : ''), role: 'radio', 'aria-checked': String(id === cur), 'aria-label': AVATAR_LABEL[id], title: AVATAR_LABEL[id],
        onclick: () => { paint(id); onPick(id); } }, avatar(id, size)));
    }
  };
  paint(value);
  return grid;
}

// ------------------------------------------------------------------ clipboard / share
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch (_) { /* fall through */ }
  const ta = h('textarea', { style: { position: 'fixed', opacity: '0', top: '0' }, readonly: '' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
  ta.remove();
  return ok;
}

export const inviteLink = (code) => `${location.origin}/?room=${code}`;

export async function shareInvite(code) {
  const url = inviteLink(code);
  const text = `Join my UNO ARENA room with code ${code}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'UNO ARENA', text, url }); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  return (await copyText(url)) ? 'copied' : 'failed';
}

export function whenIn(selector) { return $(selector); }
