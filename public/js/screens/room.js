// Screen 2 — Room setup: create / join tabs, then the room lobby (players, settings, start).
import { h, clear, Disposer } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, logoMark } from '../avatars.js';
import { store, subscribe, serverNow } from '../store.js';
import { createRoom as apiCreate, joinRoom as apiJoin, action } from '../net.js';
import { soundControl, toast, confirmModal, openModal, copyText, shareInvite, inviteLink } from '../ui.js';
import { audio } from '../audio.js';
import { shake } from '../anim.js';

const CODE_LEN = 6;
const CODE_CHARS = /[A-Z0-9]/;

const SETTING_OPTIONS = {
  maxPlayers: [2, 3, 4],
  startingCards: [5, 7, 10],
  winningScore: [100, 200, 300, 500, 1000],
  turnSeconds: [15, 20, 30, 45, 60, 90],
};

function seg(options, value, onPick, { format = String, disabled = false, label } = {}) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': label || null },
    options.map((o) => h('button', { 'aria-pressed': String(o === value), disabled, onclick: () => onPick(o) }, format(o))));
}

export function createRoomScreen(ctx, props = {}) {
  const d = new Disposer();
  let tab = props.tab === 'join' ? 'join' : 'create';
  let busy = false;
  let countdownEl = null;
  let lastCount = null;
  const body = h('div', { class: 'room-body' });
  const el = h('div', { class: 'room' }, body);

  const profile = () => store.profile;

  // ================================================================= setup (create / join)
  function setupView() {
    const errBox = h('div', { class: 'err-text', role: 'alert' });        // join tab
    const createErr = h('div', { class: 'err-text', role: 'alert' });     // create tab
    const setErr = (m) => { errBox.textContent = m || ''; };

    // ---- 6 code boxes
    const boxes = Array.from({ length: CODE_LEN }, (_, i) => h('input', {
      class: 'code-box', type: 'text', inputmode: 'text', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', maxlength: 1,
      'aria-label': `Room code character ${i + 1}`,
    }));
    const getCode = () => boxes.map((b) => b.value).join('');
    const fill = (text) => {
      const chars = [...String(text).toUpperCase()].filter((c) => CODE_CHARS.test(c)).slice(0, CODE_LEN);
      boxes.forEach((b, i) => { b.value = chars[i] || ''; });
      const next = Math.min(chars.length, CODE_LEN - 1);
      boxes[next].focus();
    };
    boxes.forEach((b, i) => {
      b.addEventListener('input', () => {
        setErr('');
        const v = b.value.toUpperCase();
        if (v.length > 1) { fill(v); return; }
        if (v && !CODE_CHARS.test(v)) { b.value = ''; return; }
        b.value = v;
        boxes.forEach((x) => x.classList.remove('err'));
        if (v && i < CODE_LEN - 1) boxes[i + 1].focus();
      });
      b.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !b.value && i > 0) { boxes[i - 1].value = ''; boxes[i - 1].focus(); e.preventDefault(); }
        else if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
        else if (e.key === 'ArrowRight' && i < CODE_LEN - 1) boxes[i + 1].focus();
        else if (e.key === 'Enter') doJoin();
      });
      b.addEventListener('paste', (e) => {
        e.preventDefault();
        fill((e.clipboardData || window.clipboardData).getData('text'));
      });
      b.addEventListener('focus', () => b.select());
    });
    if (props.code) fill(props.code);

    const createBtn = h('button', { class: 'btn lg red block', onclick: () => doCreate() }, icon('plus'), 'Create room');
    const joinBtn = h('button', { class: 'btn lg green block', onclick: () => doJoin() }, icon('arrowRight'), 'Join room');

    const setBusy = (b, btn, label, ic) => {
      busy = b;
      btn.disabled = b;
      clear(btn);
      if (b) btn.append(h('span', { class: 'spin' }), 'Working…');
      else btn.append(icon(ic), label);
    };

    async function doCreate() {
      if (busy) return;
      createErr.textContent = '';
      setBusy(true, createBtn);
      const res = await apiCreate(profile().name, profile().avatar);
      if (!res.ok) { setBusy(false, createBtn, 'Create room', 'plus'); createErr.textContent = res.message; audio.play('error'); shake(createErr); return; }
      audio.play('join');
      ctx.attach();
      // the lobby appears when the first state arrives (see subscribe below)
    }

    async function doJoin() {
      if (busy) return;
      const code = getCode().trim();
      if (!code) { setErr('PLEASE ENTER A ROOM CODE.'); boxes.forEach((b) => b.classList.add('err')); shake(boxes[0].parentElement); audio.play('error'); boxes[0].focus(); return; }
      if (code.length < CODE_LEN) { setErr('INVALID ROOM CODE.'); boxes.forEach((b) => b.classList.add('err')); shake(boxes[0].parentElement); audio.play('error'); return; }
      setErr('');
      setBusy(true, joinBtn);
      const res = await apiJoin(code, profile().name, profile().avatar);
      if (!res.ok) {
        setBusy(false, joinBtn, 'Join room', 'arrowRight');
        setErr(res.message);
        if (['INVALID_CODE', 'ROOM_NOT_FOUND', 'EMPTY_CODE'].includes(res.error)) boxes.forEach((b) => b.classList.add('err'));
        shake(boxes[0].parentElement);
        audio.play('error');
        return;
      }
      audio.play('join');
      ctx.attach();
    }

    const tabBtn = (id, label, ic) => h('button', { class: 'tab', role: 'tab', 'aria-selected': String(tab === id), id: 'tab-' + id, 'aria-controls': 'panel-' + id,
      onclick: () => { if (tab === id) return; tab = id; audio.play('click'); render(); } }, icon(ic), label);

    const createPanel = h('div', { class: 'tab-panel', role: 'tabpanel', id: 'panel-create', 'aria-labelledby': 'tab-create', hidden: tab !== 'create' },
      h('h2', { class: 'h1' }, 'Host a new room'),
      h('p', { class: 'muted' }, 'You become the host: you pick the rules, invite friends with a 6-character code and start the match.'),
      h('div', { class: 'playing-as' }, avatar(profile().avatar, 52), h('div', {}, h('div', { class: 'label' }, 'Playing as'), h('div', { class: 'h2' }, profile().name || 'Player'))),
      h('div', { class: 'default-rules' },
        h('span', { class: 'chip' }, icon('users'), 'Up to 4 players'),
        h('span', { class: 'chip' }, icon('layers'), '7 cards'),
        h('span', { class: 'chip' }, icon('trophy'), '500 points'),
        h('span', { class: 'chip' }, icon('timer'), '30 s turns')),
      h('p', { class: 'dim', style: { fontSize: '13px' } }, 'You can change every rule in the lobby before starting.'),
      createErr,
      createBtn);

    const joinPanel = h('div', { class: 'tab-panel', role: 'tabpanel', id: 'panel-join', 'aria-labelledby': 'tab-join', hidden: tab !== 'join' },
      h('h2', { class: 'h1' }, 'Join a room'),
      h('p', { class: 'muted' }, 'Enter the 6-character code your host shared with you.'),
      h('div', { class: 'code-row', role: 'group', 'aria-label': 'Room code' }, boxes.slice(0, 3), h('span', { class: 'code-dash', 'aria-hidden': 'true' }, '–'), boxes.slice(3)),
      errBox,
      joinBtn);

    const view = h('div', { class: 'setup' },
      h('header', { class: 'topbar' },
        h('button', { class: 'btn ghost sm', onclick: () => { audio.play('click'); ctx.go('welcome'); } }, icon('arrowLeft'), 'Back'),
        h('div', { class: 'brand center-brand' }, logoMark(), h('span', {}, 'UNO ARENA')),
        h('div', { class: 'tools' }, soundControl())),
      h('div', { class: 'setup-wrap' },
        h('div', { class: 'panel setup-card' },
          h('div', { class: 'tabs', role: 'tablist' }, tabBtn('create', 'Create room', 'plus'), tabBtn('join', 'Join room', 'arrowRight')),
          createPanel, joinPanel)));
    return { view, focus: () => { if (tab === 'join') (boxes.find((b) => !b.value) || boxes[0]).focus({ preventScroll: true }); } };
  }

  // ================================================================= lobby
  function slot(p, st, isHost) {
    const me = p.id === st.me;
    const kick = isHost && !me
      ? h('button', { class: 'icon-btn kick', 'aria-label': p.isBot ? `Remove ${p.name}` : `Remove ${p.name} from room`, title: p.isBot ? 'Remove bot' : 'Remove player',
          onclick: async () => {
            if (!p.isBot) { const ok = await confirmModal({ title: `Remove ${p.name}?`, body: 'They will be taken out of the room and can rejoin with the code.', confirmLabel: 'Remove', danger: true }); if (!ok) return; }
            const res = await action('kick', { target: p.id });
            if (!res.ok) toast(res.message, 'error');
          } }, icon(p.isBot ? 'x' : 'userX'))
      : null;
    return h('li', { class: 'slot filled' + (me ? ' me' : '') + (p.connected ? '' : ' offline') },
      avatar(p.avatar, 58),
      h('div', { class: 'slot-info grow' },
        h('div', { class: 'slot-name ellipsis' }, p.name),
        h('div', { class: 'slot-tags' },
          p.isHost ? h('span', { class: 'tag host' }, icon('crown'), 'Host') : null,
          p.isBot ? h('span', { class: 'tag bot' }, icon('bot'), 'Bot') : null,
          me ? h('span', { class: 'tag you' }, 'You') : null,
          !p.connected ? h('span', { class: 'tag off' }, icon('wifiOff'), 'Offline') : h('span', { class: 'tag ready' }, 'Ready'))),
      kick);
  }

  function emptySlot(isHost, canAdd) {
    return h('li', { class: 'slot empty' },
      h('span', { class: 'empty-ic' }, icon('userPlus')),
      h('div', { class: 'grow' }, h('div', { class: 'slot-name dim' }, 'Waiting for player…'), h('div', { class: 'dim', style: { fontSize: '12px' } }, 'Share the code to invite')),
      isHost && canAdd ? h('button', { class: 'btn sm ghost', onclick: async () => { audio.play('click'); const r = await action('add_bot'); if (!r.ok) toast(r.message, 'error'); } }, icon('bot'), 'Add bot') : null);
  }

  function settingRow(title, desc, control) {
    return h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('div', { class: 'setting-title' }, title), desc ? h('div', { class: 'setting-desc' }, desc) : null), control);
  }

  function lobbyView() {
    const st = store.state;
    const isHost = st.hostId === st.me;
    const s = st.settings;
    const count = st.players.length;
    const setSetting = async (patch) => {
      audio.play('click');
      const r = await action('settings', { settings: patch });
      if (!r.ok) { toast(r.message, 'error'); audio.play('error'); }
    };
    const flag = (key) => h('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!s[key]), disabled: !isHost, 'aria-label': key, onclick: () => setSetting({ [key]: !s[key] }) });

    const slots = [];
    for (let i = 0; i < s.maxPlayers; i++) slots.push(st.players[i] ? slot(st.players[i], st, isHost) : emptySlot(isHost, true));

    const codeBoxes = [...st.code].map((c) => h('span', { class: 'code-char' }, c));
    const copyBtn = h('button', { class: 'btn ghost sm', onclick: async () => {
      const ok = await copyText(st.code);
      audio.play('click');
      toast(ok ? 'ROOM CODE COPIED' : 'COULD NOT COPY — SELECT THE CODE MANUALLY', ok ? 'good' : 'error');
    } }, icon('copy'), 'Copy code');
    const shareBtn = h('button', { class: 'btn sm', onclick: () => shareModal(st.code) }, icon('share'), 'Share invitation');

    const canStart = isHost && count >= 2 && st.status === 'WAITING';
    const startBtn = isHost
      ? h('button', { class: 'btn lg green block', disabled: !canStart, onclick: async () => {
          audio.play('click');
          const r = await action('start');
          if (!r.ok) { toast(r.message, 'error'); audio.play('error'); }
        } }, icon('play'), 'Start match')
      : h('div', { class: 'waiting-host' }, h('span', { class: 'dots' }, h('i'), h('i'), h('i')), 'Waiting for the host to start…');

    return h('div', { class: 'lobby' },
      h('header', { class: 'topbar' },
        h('div', { class: 'brand' }, logoMark(), h('span', {}, 'UNO ARENA')),
        h('div', { class: 'tools' }, soundControl(),
          h('button', { class: 'btn ghost sm', onclick: async () => {
            const ok = await confirmModal({ title: 'Leave this room?', body: isHost && count > 1 ? 'The host role will pass to another player.' : 'You can rejoin later with the room code while it is open.', confirmLabel: 'Leave room', danger: true });
            if (ok) ctx.leave();
          } }, icon('logout'), 'Leave'))),
      h('div', { class: 'lobby-grid' },
        h('div', { class: 'lobby-main' },
          h('section', { class: 'panel code-card' },
            h('div', { class: 'label' }, 'Room code'),
            h('div', { class: 'code-display', 'aria-label': 'Room code ' + [...st.code].join(' ') }, codeBoxes.slice(0, 3), h('span', { class: 'code-dash' }, '–'), codeBoxes.slice(3)),
            h('div', { class: 'row gap-3 code-actions' }, copyBtn, shareBtn)),
          h('section', { class: 'panel players-card' },
            h('div', { class: 'row card-head' }, h('h2', { class: 'h2 grow' }, 'Players'), h('span', { class: 'chip' }, icon('users'), `${count} / ${s.maxPlayers}`)),
            h('ul', { class: 'slots' }, slots))),
        h('aside', { class: 'lobby-side' },
          h('section', { class: 'panel settings-card' },
            h('div', { class: 'row card-head' }, h('h2', { class: 'h2 grow' }, 'Match settings'),
              isHost ? h('span', { class: 'chip' }, icon('crown'), 'Host') : h('span', { class: 'chip' }, icon('lock'), 'Host only')),
            settingRow('Max players', null, seg(SETTING_OPTIONS.maxPlayers, s.maxPlayers, (v) => setSetting({ maxPlayers: v }), { disabled: !isHost, label: 'Max players' })),
            settingRow('Starting cards', null, seg(SETTING_OPTIONS.startingCards, s.startingCards, (v) => setSetting({ startingCards: v }), { disabled: !isHost, label: 'Starting cards' })),
            settingRow('Winning score', 'First to reach this score wins the match', seg(SETTING_OPTIONS.winningScore, s.winningScore, (v) => setSetting({ winningScore: v }), { disabled: !isHost, label: 'Winning score' })),
            settingRow('Turn timer', 'Seconds per turn before auto-draw', seg(SETTING_OPTIONS.turnSeconds, s.turnSeconds, (v) => setSetting({ turnSeconds: v }), { disabled: !isHost, format: (v) => v + 's', label: 'Turn timer' })),
            h('div', { class: 'divider' }),
            settingRow('Stacking', 'Answer +2 with +2, and +4 with +4 (house rule)', flag('stacking')),
            settingRow('Jump-in', 'Play an identical card out of turn (house rule)', flag('jumpIn')),
            settingRow('Draw until playable', 'Keep drawing until a card can be played (house rule)', flag('drawUntilPlayable'))),
          h('div', { class: 'start-area' },
            startBtn,
            isHost && !canStart && st.status === 'WAITING' ? h('p', { class: 'dim center', style: { fontSize: '13px' } }, 'You need at least 2 players — share the code or add a bot.') : null))));
  }

  function shareModal(code) {
    const link = inviteLink(code);
    const input = h('input', { class: 'input', readonly: '', value: link, 'aria-label': 'Invitation link', onfocus: (e) => e.target.select() });
    let m;
    m = openModal([
      h('h2', {}, 'Share invitation'),
      h('p', {}, 'Send this link or the code to friends. Anyone with it can join while the room is open.'),
      h('div', { class: 'share-code' }, [...code].map((c) => h('span', { class: 'code-char sm' }, c))),
      h('div', { class: 'field', style: { marginTop: '16px' } }, h('label', { class: 'label' }, 'Invitation link'), input),
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost', onclick: async () => { const ok = await copyText(link); toast(ok ? 'LINK COPIED' : 'COULD NOT COPY THE LINK', ok ? 'good' : 'error'); } }, icon('link'), 'Copy link'),
        navigator.share ? h('button', { class: 'btn', onclick: async () => { const r = await shareInvite(code); if (r === 'copied') toast('LINK COPIED', 'good'); m.close(); } }, icon('share'), 'Share…') : null,
        h('button', { class: 'btn ghost', 'data-autofocus': '', onclick: () => m.close() }, 'Close')),
    ], { label: 'Share invitation' });
  }

  // ================================================================= countdown overlay
  function syncCountdown() {
    const st = store.state;
    if (st && st.status === 'STARTING' && st.countdownEndsAt) {
      if (!countdownEl) {
        countdownEl = h('div', { class: 'countdown', role: 'status', 'aria-live': 'assertive' }, h('div', { class: 'cd-label' }, 'Match starting'), h('div', { class: 'cd-num' }, '3'));
        el.append(countdownEl);
        lastCount = null;
      }
    } else if (countdownEl) {
      countdownEl.remove(); countdownEl = null; lastCount = null;
    }
  }

  d.interval(() => {
    if (!countdownEl || !store.state) return;
    const ms = store.state.countdownEndsAt - serverNow();
    const n = Math.max(1, Math.ceil(ms / 1000));
    if (n !== lastCount) {
      lastCount = n;
      const num = countdownEl.querySelector('.cd-num');
      num.textContent = String(n);
      num.classList.remove('bump'); void num.offsetWidth; num.classList.add('bump');
      audio.play(n === 1 ? 'go' : 'countdown');
    }
  }, 100);

  // ================================================================= render / lifecycle
  let setupFocus = null;
  function render() {
    clear(body);
    countdownEl = null;
    setupFocus = null;
    if (store.state && (store.state.status === 'WAITING' || store.state.status === 'STARTING')) {
      body.append(lobbyView());
      syncCountdown();
    } else {
      const s = setupView();
      body.append(s.view);
      setupFocus = s.focus;
    }
  }

  let lastShape = '';
  const refresh = () => {
    const st = store.state;
    const mode = st ? 'lobby' : 'setup';
    // lobby re-renders on every state change; setup only when the mode flips
    if (mode === 'setup' && lastShape === 'setup') return;
    lastShape = mode;
    const active = document.activeElement;
    const keepScroll = el.scrollTop;
    render();
    el.scrollTop = keepScroll;
    void active;
  };
  d.add(subscribe((keys) => { if (keys.includes('state')) refresh(); }));

  return {
    el,
    mount() { refresh(); if (setupFocus) setTimeout(setupFocus, 350); },
    onEvents(msg) {
      for (const ev of msg.events || []) {
        if (ev.type === 'player_joined' && ev.pid !== store.state.me && !(ev.bot && store.state.hostId === store.state.me)) { audio.play('join'); toast(`${ev.name} joined the room`, 'info'); }
        else if (ev.type === 'player_left' && ev.pid !== store.state.me) { audio.play('leave'); toast(`${ev.name} ${ev.reason === 'kicked' ? 'was removed' : 'left'}`, 'info'); }
        else if (ev.type === 'host_changed') toast(ev.pid === store.state.me ? 'YOU ARE NOW THE HOST' : `${ev.name} is now the host`, 'info');
        else if (ev.type === 'start_cancelled') toast('START CANCELLED — A PLAYER LEFT', 'info');
        else if (ev.type === 'player_disconnected') toast(`${ev.name} lost connection`, 'error');
        else if (ev.type === 'player_reconnected') toast(`${ev.name} is back`, 'good');
      }
    },
    unmount() { d.dispose(); },
  };
}
