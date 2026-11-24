// Screen 1 — Welcome / entry.
import { h, clear, Disposer } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, logoMark, AVATAR_IDS, AVATAR_LABEL } from '../avatars.js';
import { createHeroTable } from '../hero-table.js';
import { canInstall, onInstallChange, promptInstall, isStandalone } from '../pwa.js';
import { store, setProfile } from '../store.js';
import { getStats } from '../net.js';
import { soundControl, openModal, avatarPicker, framePicker, openGuide } from '../ui.js';
import { audio } from '../audio.js';
import { shake } from '../anim.js';
import { cardEl } from '../cards.js';
import { reducedMotion } from '../store.js';

export const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]{1,15}$/u;
export const NAME_ERROR = 'ENTER A NICKNAME (2–16 LETTERS OR NUMBERS).';

export function cleanName(v) { return String(v || '').replace(/\s+/g, ' ').trim(); }

// Out-of-focus metal cards drifting behind the page. They give the hero depth and slide against the pointer.
const DRIFT = [
  { card: { id: 9101, color: 'red', kind: 'num', value: 7 }, l: '3%', t: '58%', w: 150, blur: 3, depth: 26, o: 0.32, rot: '-14deg', dur: '17s', delay: '-3s' },
  { card: { id: 9102, color: 'blue', kind: 'skip', value: null }, l: '41%', t: '4%', w: 120, blur: 5, depth: 14, o: 0.24, rot: '11deg', dur: '21s', delay: '-9s' },
  { card: { id: 9103, color: 'yellow', kind: 'draw2', value: null }, l: '88%', t: '12%', w: 170, blur: 2, depth: 34, o: 0.34, rot: '16deg', dur: '19s', delay: '-6s' },
  { card: { id: 9104, color: 'green', kind: 'num', value: 5 }, l: '74%', t: '74%', w: 130, blur: 4, depth: 18, o: 0.26, rot: '-9deg', dur: '23s', delay: '-12s' },
  { card: { id: 9105, color: null, kind: 'wild', value: null }, l: '24%', t: '82%', w: 100, blur: 6, depth: 10, o: 0.2, rot: '8deg', dur: '25s', delay: '-4s' },
];
function driftLayer() {
  return h('div', { class: 'hero-drift', 'aria-hidden': 'true' }, DRIFT.map((c) => h('span', { class: 'drift', style: { '--l': c.l, '--t': c.t, '--w': c.w, '--blur': c.blur, '--depth': c.depth, '--o': c.o, '--rot': c.rot, '--dur': c.dur, '--delay': c.delay } },
    h('span', { class: 'drift-in' }, cardEl(c.card, { size: 'hero' })))));
}

export function createWelcome(ctx, props = {}) {
  const d = new Disposer();
  const invite = props.invite && props.invite.length ? props.invite : '';

  // ---- profile card
  if (!store.profile.avatar || !AVATAR_IDS.includes(store.profile.avatar)) setProfile({ avatar: AVATAR_IDS[Math.floor(Math.random() * AVATAR_IDS.length)] });
  const avatarSlot = h('button', { class: 'profile-avatar', 'aria-label': 'Change avatar', title: 'Change avatar' });
  const paintAvatar = () => {
    clear(avatarSlot);
    avatarSlot.append(avatar(store.profile.avatar, 84, '', store.profile.frame), h('span', { class: 'edit-badge' }, icon('refresh')));
  };
  paintAvatar();
  avatarSlot.addEventListener('click', () => {
    audio.play('click');
    let pick = store.profile.avatar;
    const framesHost = h('div', {});
    const paintFrames = () => { clear(framesHost); framesHost.append(framePicker({ avatarId: store.profile.avatar, value: store.profile.frame || 'steel', size: 56, onPick: (id) => { setProfile({ frame: id }); paintAvatar(); audio.play('click'); } })); };
    paintFrames();
    const grid = avatarPicker({ value: pick, size: 72, onPick: (id) => { pick = id; setProfile({ avatar: id }); paintAvatar(); paintFrames(); audio.play('click'); } });
    const m = openModal([
      h('h2', {}, 'Choose your avatar'),
      h('p', {}, 'This is how other players see you at the table.'),
      grid,
      h('h3', { class: 'frame-title' }, 'Frame'),
      h('p', { class: 'frame-sub' }, 'A ring around your avatar. Everyone at the table sees it.'),
      framesHost,
      h('div', { class: 'actions' }, h('button', { class: 'btn', 'data-autofocus': '', onclick: () => m.close() }, 'Done')),
    ], { label: 'Choose your avatar and frame' });
  });

  const nameInput = h('input', {
    class: 'input', type: 'text', id: 'nick', name: 'nickname', maxlength: 16, autocomplete: 'nickname', spellcheck: 'false',
    placeholder: 'Your nickname', value: store.profile.name || '', 'aria-describedby': 'nick-err', 'aria-label': 'Nickname',
  });
  const nameErr = h('div', { class: 'err-text', id: 'nick-err', role: 'alert' });
  nameInput.addEventListener('input', () => { nameErr.textContent = ''; nameInput.classList.remove('err'); });

  const validName = () => {
    const name = cleanName(nameInput.value);
    if (!NAME_RE.test(name)) {
      nameErr.textContent = NAME_ERROR;
      nameInput.classList.add('err');
      shake(nameInput);
      audio.play('error');
      nameInput.focus();
      return null;
    }
    setProfile({ name });
    return name;
  };

  const go = (tab) => {
    if (!validName()) return;
    audio.play('click');
    ctx.go('room', { tab, code: tab === 'join' ? invite : '' });
  };

  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(invite ? 'join' : 'create'); });

  // ---- live ticker (only real numbers; hidden when there is nothing to show)
  const live = h('span', { class: 'chip live', hidden: true });
  const loadStats = async () => {
    const s = await getStats();
    if (!s || !live.isConnected) return;
    if (s.online > 0) { live.hidden = false; live.textContent = `${s.online} ${s.online === 1 ? 'player' : 'players'} online`; }
    else live.hidden = true;
  };
  d.interval(loadStats, 15000);

  // ---- top bar: help, settings, install (only when the browser offers it), sound
  const installBtn = h('button', { class: 'top-link', hidden: true, onclick: async () => { const ok = await promptInstall(); if (ok) audio.play('join'); } }, icon('download'), h('span', {}, 'Install app'));
  const paintInstall = () => { installBtn.hidden = !canInstall() || isStandalone(); };
  paintInstall();
  d.add(onInstallChange(paintInstall));
  const openSettingsModal = async () => { const m = await import('../settings.js'); m.openSettings({ onGuide: openGuide }); };

  const table = createHeroTable();

  const el = h('div', { class: 'welcome' }, driftLayer(),
    h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, logoMark(), h('span', {}, 'UNO ARENA')),
      h('div', { class: 'top-tools' },
        installBtn,
        h('button', { class: 'top-link', 'aria-label': 'How to play', onclick: () => { audio.play('click'); openGuide(); } }, icon('help'), h('span', {}, 'How to play')),
        h('button', { class: 'icon-btn', 'aria-label': 'Settings', title: 'Settings', onclick: () => { audio.play('click'); openSettingsModal(); } }, icon('gear')),
        soundControl())),
    h('section', { class: 'hero' },
      h('div', { class: 'hero-copy' },
        h('div', { class: 'ticker' }, live, h('span', { class: 'chip' }, icon('zap'), 'Real-time multiplayer'), h('span', { class: 'chip' }, icon('users'), '2–4 players')),
        h('h1', { class: 'display hero-title' }, h('span', { class: 't-line t-steel' }, 'Play together.'), h('br'), h('span', { class: 't-line grad-text', style: { '--d': '.14s' } }, 'Outsmart', h('br'), 'everyone.')),
        h('p', { class: 'hero-sub' }, 'Create a private room, share the code, and battle your friends in a fast, fair card arena. Every move is validated by the server.'),
        invite ? h('div', { class: 'invite-banner', role: 'status' }, icon('link'), h('span', {}, 'You were invited to room ', h('b', { class: 'mono' }, invite))) : null,
        h('div', { class: 'panel profile' },
          avatarSlot,
          h('div', { class: 'field grow' },
            h('label', { class: 'label', for: 'nick' }, 'Your nickname'),
            nameInput,
            nameErr)),
        h('div', { class: 'cta' },
          invite
            ? [h('button', { class: 'btn lg green', onclick: () => go('join') }, icon('arrowRight'), 'Join room ' + invite),
               h('button', { class: 'btn lg ghost', onclick: () => go('create') }, icon('plus'), 'Create room')]
            : [h('button', { class: 'btn lg red', onclick: () => go('create') }, icon('plus'), 'Create room'),
               h('button', { class: 'btn lg ghost', onclick: () => go('join') }, icon('arrowRight'), 'Join room')]),
        h('ul', { class: 'perks' },
          h('li', {}, icon('shield'), 'Server-authoritative rules'),
          h('li', {}, icon('bot'), 'Add bots to fill seats'),
          h('li', {}, icon('refresh'), 'Reconnect if you drop'))),
      h('div', { class: 'hero-play' }, table.el)),
    h('footer', { class: 'foot dim' }, 'Fan-made card game · Play responsibly · Sound is off until you turn it on'));

  // depth layer follows the mouse (never on touch, never with reduced motion)
  let praf = 0; let px = 0; let py = 0;
  const applyParallax = () => { praf = 0; el.style.setProperty('--px', px.toFixed(3)); el.style.setProperty('--py', py.toFixed(3)); };
  const onMove = (e) => {
    if (e.pointerType !== 'mouse' || reducedMotion()) return;
    px = (e.clientX / window.innerWidth - 0.5) * 2; py = (e.clientY / window.innerHeight - 0.5) * 2;
    if (!praf) praf = requestAnimationFrame(applyParallax);
  };
  el.addEventListener('pointermove', onMove);
  d.add(() => { el.removeEventListener('pointermove', onMove); cancelAnimationFrame(praf); });

  return {
    el,
    mount() { loadStats(); table.mount(); if (!nameInput.value) setTimeout(() => nameInput.focus({ preventScroll: true }), 400); },
    unmount() { table.unmount(); d.dispose(); },
  };
}
