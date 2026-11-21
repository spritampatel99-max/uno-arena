// Screen 1 — Welcome / entry.
import { h, clear, Disposer } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, logoMark, AVATAR_IDS, AVATAR_LABEL } from '../avatars.js';
import { cardEl } from '../cards.js';
import { store, setProfile } from '../store.js';
import { getStats } from '../net.js';
import { soundControl, openModal, avatarPicker } from '../ui.js';
import { audio } from '../audio.js';
import { shake } from '../anim.js';

export const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]{1,15}$/u;
export const NAME_ERROR = 'ENTER A NICKNAME (2–16 LETTERS OR NUMBERS).';

export function cleanName(v) { return String(v || '').replace(/\s+/g, ' ').trim(); }

export function createWelcome(ctx, props = {}) {
  const d = new Disposer();
  const invite = props.invite && props.invite.length ? props.invite : '';

  // ---- profile card
  if (!store.profile.avatar || !AVATAR_IDS.includes(store.profile.avatar)) setProfile({ avatar: AVATAR_IDS[Math.floor(Math.random() * AVATAR_IDS.length)] });
  const avatarSlot = h('button', { class: 'profile-avatar', 'aria-label': 'Change avatar', title: 'Change avatar' });
  const paintAvatar = () => {
    clear(avatarSlot);
    avatarSlot.append(avatar(store.profile.avatar, 84), h('span', { class: 'edit-badge' }, icon('refresh')));
  };
  paintAvatar();
  avatarSlot.addEventListener('click', () => {
    audio.play('click');
    let pick = store.profile.avatar;
    const grid = avatarPicker({ value: pick, size: 72, onPick: (id) => { pick = id; setProfile({ avatar: id }); paintAvatar(); audio.play('click'); } });
    const m = openModal([
      h('h2', {}, 'Choose your avatar'),
      h('p', {}, 'This is how other players see you at the table.'),
      grid,
      h('div', { class: 'actions' }, h('button', { class: 'btn', 'data-autofocus': '', onclick: () => m.close() }, 'Done')),
    ], { label: 'Choose your avatar' });
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

  const el = h('div', { class: 'welcome' },
    h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, logoMark(), h('span', {}, 'UNO ARENA')),
      h('div', { class: 'tools' }, soundControl())),
    h('section', { class: 'hero' },
      h('div', { class: 'ticker' }, live, h('span', { class: 'chip' }, icon('zap'), 'Real-time multiplayer'), h('span', { class: 'chip' }, icon('users'), '2–4 players')),
      h('h1', { class: 'display hero-title' }, 'Play together.', h('br'), h('span', { class: 'grad-text' }, 'Outsmart everyone.')),
      h('p', { class: 'hero-sub' }, 'Create a private room, share the code, and battle your friends in a fast, fair card arena. Every move is validated by the server.'),
      h('div', { class: 'card-stage', 'aria-hidden': 'true' },
        h('div', { class: 'stage-card s1' }, cardEl({ id: -1, color: 'red', kind: 'draw2', value: null }, { size: 'hero' })),
        h('div', { class: 'stage-card s2' }, cardEl({ id: -2, color: 'blue', kind: 'skip', value: null }, { size: 'hero' })),
        h('div', { class: 'stage-card s3' }, cardEl({ id: -3, color: null, kind: 'wild4', value: null }, { size: 'hero' })),
        h('div', { class: 'stage-card s4' }, cardEl({ id: -4, color: 'green', kind: 'num', value: 7 }, { size: 'hero' })),
        h('div', { class: 'stage-card s5' }, cardEl({ id: -5, color: 'yellow', kind: 'reverse', value: null }, { size: 'hero' }))),
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
    h('footer', { class: 'foot dim' }, 'Fan-made card game · Play responsibly · Sound is off until you turn it on'));

  return {
    el,
    mount() { loadStats(); if (!nameInput.value) setTimeout(() => nameInput.focus({ preventScroll: true }), 400); },
    unmount() { d.dispose(); },
  };
}
