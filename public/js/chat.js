// Table chat. One panel for the whole app, so it survives screen changes and lobby re-renders and never loses
// what you were typing. Screens only place a small launcher button (chatButton()); everything else lives here.
//
// Safety: message text is only ever put into the page with textContent (never as HTML), links are not made
// clickable, and the server limits length and rate. Muting is local: it hides a player's messages for you only.
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { avatar } from './avatars.js';
import { store, subscribe } from './store.js';
import { action } from './net.js';
import { audio } from './audio.js';
import { uiScale } from './scale.js';

const MAX_CHARS = 200;
const KEEP = 200;                 // messages kept in the list
const NAME_COLOURS = ['#ff8a90', '#7eb3ff', '#f9d83d', '#52e3a0'];
const PEEK_MS = 5200;

const chat = {
  code: null,        // the room this history belongs to
  items: [],         // { id, pid, name, text, at } or { sys: true, text }
  lastId: 0,
  unread: 0,
  open: false,
  muted: new Set(),
  pendingBelow: 0,   // messages that arrived while scrolled up
};

let root = null;
let panel = null;
const ui = {};
const launchers = new Set();
let lastLauncher = null;
let peekTimer = 0;
let errorTimer = 0;
let screenName = '';
let sending = false;

const coarse = () => window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
const narrow = () => window.matchMedia && window.matchMedia('(max-width: 700px)').matches;

// ------------------------------------------------------------------ helpers
const me = () => (store.state ? store.state.me : null);
const players = () => (store.state ? store.state.players : []);
const playerOf = (pid) => players().find((p) => p.id === pid) || null;
const colourOf = (pid) => {
  const i = players().findIndex((p) => p.id === pid);
  if (i >= 0) return NAME_COLOURS[i % NAME_COLOURS.length];
  let n = 0; for (const ch of String(pid)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return NAME_COLOURS[n % NAME_COLOURS.length];
};
const clock = (at) => { try { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } };
const chatIsOn = () => !store.state || store.state.chatOn !== false;
const isMuted = (pid) => chat.muted.has(pid);
const myTurn = () => { const g = store.state && store.state.game; return !!(g && g.phase === 'playing' && g.turnId === me()); };

function loadMuted(code) {
  try { return new Set(JSON.parse(sessionStorage.getItem('uno.chat.muted.' + code) || '[]')); } catch (_) { return new Set(); }
}
function saveMuted() {
  try { sessionStorage.setItem('uno.chat.muted.' + chat.code, JSON.stringify([...chat.muted])); } catch (_) { /* storage unavailable: muting simply lasts for this page view */ }
}

function nearBottom() { return ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 70; }
function toBottom() { ui.log.scrollTop = ui.log.scrollHeight; chat.pendingBelow = 0; paintMore(); }

// ------------------------------------------------------------------ rendering
function avatarFor(pid, name) {
  const p = playerOf(pid);
  if (p) return avatar(p.avatar, 30, '', p.frame);
  return h('span', { class: 'avatar chat-ghost', style: { width: 'calc(30px * var(--s))', height: 'calc(30px * var(--s))' }, 'aria-hidden': 'true' }, (name || '?').slice(0, 1).toUpperCase());
}

function itemEl(it, prev) {
  if (it.sys) return h('div', { class: 'chat-sys' }, it.text);
  const mine = it.pid === me();
  const grouped = !!(prev && !prev.sys && prev.pid === it.pid && it.at - prev.at < 90000);
  const bubble = h('div', { class: 'chat-bubble' },
    mine || grouped ? null : h('div', { class: 'chat-meta' }, h('b', { class: 'chat-name', style: { color: colourOf(it.pid) } }, it.name), h('time', {}, clock(it.at))),
    h('p', { class: 'chat-text' }, it.text));
  if (mine && !grouped) bubble.append(h('time', { class: 'chat-time-mine' }, clock(it.at)));
  return h('div', { class: 'chat-msg' + (mine ? ' mine' : '') + (grouped ? ' grouped' : ''), dataset: { id: String(it.id) } },
    mine ? null : h('span', { class: 'chat-av' }, grouped ? null : avatarFor(it.pid, it.name)),
    bubble);
}

const shown = () => chat.items.filter((it) => it.sys || !isMuted(it.pid));

function renderAll() {
  if (!ui.log) return;
  clear(ui.log);
  const list = shown();
  if (!list.length) {
    ui.log.append(h('div', { class: 'chat-empty' }, icon('message'), h('p', {}, chatIsOn() ? 'No messages yet. Say hello, or wish everyone luck.' : 'Chat is turned off in this room.')));
  }
  let prev = null;
  for (const it of list) { ui.log.append(itemEl(it, prev)); prev = it; }
  toBottom();
}

function appendRendered(it) {
  if (!ui.log) return;
  if (it.sys === undefined && isMuted(it.pid)) return;
  const empty = ui.log.querySelector('.chat-empty');
  if (empty) empty.remove();
  const list = shown();
  const prev = list.length > 1 ? list[list.length - 2] : null;
  const stick = nearBottom() || it.pid === me();
  const node = itemEl(it, prev);
  node.classList.add('fresh');
  ui.log.append(node);
  if (stick) toBottom();
  else if (chat.open) { chat.pendingBelow += 1; paintMore(); }
}

function paintMore() {
  if (!ui.more) return;
  ui.more.hidden = chat.pendingBelow === 0;
  ui.more.textContent = chat.pendingBelow === 1 ? '1 new message' : `${chat.pendingBelow} new messages`;
  ui.more.append(icon('chevron'));
}

function paintLauncher(b) {
  const n = chat.unread;
  const badge = b.querySelector('.chat-badge');
  badge.hidden = n === 0;
  badge.textContent = n > 9 ? '9+' : String(n);
  b.classList.toggle('has-unread', n > 0);
  b.setAttribute('aria-expanded', String(chat.open));
  b.setAttribute('aria-label', n ? `Chat, ${n} unread message${n === 1 ? '' : 's'}` : 'Chat');
}

function paintLaunchers() {
  for (const b of [...launchers]) {
    if (!b.isConnected) { launchers.delete(b); continue; }   // screens rebuild their toolbar, so old buttons are dropped here
    paintLauncher(b);
  }
}

function paintState() {
  if (!ui.input) return;
  const on = chatIsOn();
  ui.input.disabled = !on;
  ui.send.disabled = !on || sending;
  ui.input.placeholder = on ? 'Write a message' : 'Chat is off in this room';
  ui.off.hidden = on;
  const st = store.state;
  ui.sub.textContent = st ? `${st.players.filter((p) => !p.isBot).length} in the room` : '';
  const showTurn = chat.open && myTurn();
  ui.turn.hidden = !showTurn;
  panel.classList.toggle('your-turn', showTurn);
  paintOptions();
}

function paintOptions() {
  if (!ui.opts || ui.opts.hidden) return;
  clear(ui.opts);
  const st = store.state;
  if (!st) return;
  const others = st.players.filter((p) => !p.isBot && p.id !== st.me);
  ui.opts.append(h('div', { class: 'chat-opts-title' }, 'People'));
  if (!others.length) ui.opts.append(h('p', { class: 'chat-opts-note' }, 'Nobody else is here yet.'));
  for (const p of others) {
    const muted = isMuted(p.id);
    ui.opts.append(h('div', { class: 'chat-person' },
      avatar(p.avatar, 28, '', p.frame),
      h('span', { class: 'chat-person-name' }, p.name),
      h('button', { class: 'chat-chip' + (muted ? ' on' : ''), type: 'button', 'aria-pressed': String(muted), 'aria-label': `${muted ? 'Unmute' : 'Mute'} ${p.name}`, onclick: () => toggleMute(p) }, muted ? 'Muted' : 'Mute')));
  }
  ui.opts.append(h('p', { class: 'chat-opts-note' }, 'Muting hides someone’s messages for you only.'));
  if (st.hostId === st.me) {
    const on = chatIsOn();
    ui.opts.append(h('div', { class: 'chat-host' },
      h('div', {}, h('b', {}, 'Allow chat in this room'), h('span', {}, 'Host setting. Applies to everyone.')),
      h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': 'Allow chat in this room', onclick: () => setChatMode(!on) })));
  }
}

function toggleMute(p) {
  if (isMuted(p.id)) chat.muted.delete(p.id); else chat.muted.add(p.id);
  saveMuted();
  renderAll();
  paintOptions();
}

async function setChatMode(on) {
  const res = await action('chat_mode', { on });
  if (!res.ok) showError(res.message || 'COULD NOT CHANGE CHAT.');
}

function showError(text) {
  clearTimeout(errorTimer);
  ui.error.textContent = text;
  ui.error.hidden = false;
  errorTimer = setTimeout(() => { ui.error.hidden = true; }, 3400);
}

// ------------------------------------------------------------------ open / close
export function openChat(opener) {
  if (!panel) return;
  if (opener) lastLauncher = opener;
  chat.open = true;
  chat.unread = 0;
  hidePeek();
  panel.inert = false;
  panel.setAttribute('aria-hidden', 'false');
  panel.classList.add('open');
  paintLaunchers(); paintState();
  renderAll();
  if (!coarse() && chatIsOn()) setTimeout(() => ui.input.focus({ preventScroll: true }), 60);
}

export function closeChat({ restoreFocus = true } = {}) {
  if (!panel || !chat.open) return;
  chat.open = false;
  panel.classList.remove('open');
  panel.inert = true;
  panel.setAttribute('aria-hidden', 'true');
  ui.opts.hidden = true;
  ui.people.setAttribute('aria-expanded', 'false');
  paintLaunchers(); paintState();
  if (restoreFocus && lastLauncher && lastLauncher.isConnected && panel.contains(document.activeElement)) lastLauncher.focus({ preventScroll: true });
  else if (panel.contains(document.activeElement)) document.activeElement.blur();
}

function toggleChat(opener) { if (chat.open) closeChat(); else openChat(opener); }

// ------------------------------------------------------------------ incoming messages
function ingest(msg, { live, count = true }) {
  if (!msg || typeof msg.id !== 'number' || msg.id <= chat.lastId) return;
  chat.lastId = msg.id;
  const it = { id: msg.id, pid: msg.pid, name: String(msg.name || ''), text: String(msg.text || ''), at: Number(msg.at) || Date.now() };
  chat.items.push(it);
  if (chat.items.length > KEEP) chat.items.shift();
  const fromOther = it.pid !== me();
  if (!fromOther || isMuted(it.pid)) { if (panel) appendRendered(it); return; }
  if (panel) appendRendered(it);
  if (chat.open || !count) return;
  chat.unread += 1;
  paintLaunchers();
  if (live && store.prefs.chatAlerts && chatIsOn()) {
    showPeek(it);
    audio.play('chat');
  }
}

function addSystem(text) {
  const it = { sys: true, text };
  chat.items.push(it);
  if (chat.items.length > KEEP) chat.items.shift();
  if (panel) appendRendered(it);
}

function reset(code) {
  chat.code = code;
  chat.items = [];
  chat.lastId = 0;
  chat.unread = 0;
  chat.pendingBelow = 0;
  chat.muted = code ? loadMuted(code) : new Set();
  hidePeek();
  if (chat.open) closeChat({ restoreFocus: false });
  if (ui.log) renderAll();
  paintLaunchers();
}

/** Called for every `sync` from the server (first connect and every reconnect). */
export function chatSync(msg) {
  const code = msg.state && msg.state.code;
  if (!code) return;
  const sameRoom = chat.code === code;
  if (!sameRoom) reset(code);
  // anything missed while we were disconnected counts as unread; the history you receive on first joining does not
  for (const m of msg.chat || []) ingest(m, { live: false, count: sameRoom });
  paintState();
}

/** Called for every `update` (the events behind a state change). */
export function chatEvents(msg) {
  for (const ev of msg.events || []) {
    if (ev.type === 'chat') ingest(ev.msg, { live: true });
    else if (ev.type === 'chat_mode') addSystem(ev.on ? `${ev.pid === me() ? 'You' : ev.name} turned chat on.` : `${ev.pid === me() ? 'You' : ev.name} turned chat off.`);
  }
  paintState();
}

// ------------------------------------------------------------------ preview bubble
function hidePeek() {
  clearTimeout(peekTimer);
  if (ui.peek) { ui.peek.classList.remove('show'); ui.peek.inert = true; }
}

function showPeek(it) {
  if (!ui.peek) return;
  const anchor = [...launchers].find((b) => b.isConnected);
  const r = anchor ? anchor.getBoundingClientRect() : null;
  const k = uiScale();
  ui.peek.style.top = (r ? r.bottom + 10 * k : 72 * k) + 'px';
  ui.peek.style.right = (r ? Math.max(10 * k, window.innerWidth - r.right) : 14 * k) + 'px';
  clear(ui.peek);
  ui.peek.append(avatarFor(it.pid, it.name), h('span', { class: 'peek-body' }, h('b', { style: { color: colourOf(it.pid) } }, it.name), h('span', { class: 'peek-text' }, it.text)));
  ui.peek.inert = false;
  ui.peek.classList.remove('show'); void ui.peek.offsetWidth; ui.peek.classList.add('show');
  clearTimeout(peekTimer);
  peekTimer = setTimeout(hidePeek, PEEK_MS);
}

// ------------------------------------------------------------------ sending
async function send() {
  if (sending || !chatIsOn()) return;
  const text = ui.input.value.replace(/\s+/g, ' ').trim();
  if (!text) return;
  if (Array.from(text).length > MAX_CHARS) { showError('THAT MESSAGE IS TOO LONG (200 CHARACTERS AT MOST).'); return; }
  sending = true; ui.send.disabled = true;
  const res = await action('chat', { text });
  sending = false; ui.send.disabled = !chatIsOn();
  // only clear the box if nothing new was typed while the message was on its way (slow connections)
  if (res.ok) { if (ui.input.value.replace(/\s+/g, ' ').trim() === text) ui.input.value = ''; ui.error.hidden = true; paintCount(); }
  else { showError(res.message || 'MESSAGE NOT SENT.'); audio.play('error'); }
  ui.input.focus({ preventScroll: true });
}

function paintCount() {
  const n = Array.from(ui.input.value).length;
  ui.count.textContent = n >= 150 ? `${n}/${MAX_CHARS}` : '';
  ui.count.classList.toggle('warn', n >= 190);
}

// ------------------------------------------------------------------ build
function build() {
  ui.title = h('h2', { id: 'chat-title' }, 'Table chat');
  ui.sub = h('span', { class: 'chat-sub' });
  ui.people = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'People and chat options', 'aria-expanded': 'false', onclick: () => {
    ui.opts.hidden = !ui.opts.hidden;
    ui.people.setAttribute('aria-expanded', String(!ui.opts.hidden));
    paintOptions();
  } }, icon('users'));
  const close = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Close chat', onclick: () => closeChat() }, icon('x'));
  ui.opts = h('div', { class: 'chat-opts', hidden: '' });
  ui.turn = h('div', { class: 'chat-turn', hidden: '', role: 'status' }, h('span', {}, h('i', { class: 'dot' }), 'It is your turn'), h('button', { class: 'btn sm', type: 'button', onclick: () => closeChat() }, 'Back to table'));
  ui.off = h('div', { class: 'chat-off', hidden: '' }, icon('lock'), 'The host has turned chat off. You can still read what was said.');
  ui.log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'Messages', tabindex: '0' });
  ui.log.addEventListener('scroll', () => { if (nearBottom() && chat.pendingBelow) { chat.pendingBelow = 0; paintMore(); } }, { passive: true });
  ui.more = h('button', { class: 'chat-more', type: 'button', hidden: '', onclick: toBottom });
  ui.error = h('div', { class: 'chat-error', role: 'alert', hidden: '' });
  ui.input = h('input', { class: 'chat-input', type: 'text', maxlength: String(MAX_CHARS), autocomplete: 'off', autocapitalize: 'sentences', enterkeyhint: 'send', 'aria-label': 'Message', placeholder: 'Write a message', spellcheck: 'true' });
  ui.input.addEventListener('input', () => { paintCount(); if (!ui.error.hidden) ui.error.hidden = true; });
  ui.count = h('span', { class: 'chat-count', 'aria-hidden': 'true' });
  ui.send = h('button', { class: 'chat-send', type: 'submit', 'aria-label': 'Send message' }, icon('send'));
  const form = h('form', { class: 'chat-form', onsubmit: (e) => { e.preventDefault(); send(); } }, h('div', { class: 'chat-field' }, ui.input, ui.count), ui.send);

  panel = h('section', { class: 'chat', id: 'chat-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'chat-title', 'aria-hidden': 'true' },
    h('header', { class: 'chat-head' }, h('div', { class: 'grow' }, ui.title, ui.sub), ui.people, close),
    ui.opts, ui.turn, ui.off, ui.log, ui.more, ui.error, form);
  panel.inert = true;
  ui.peek = h('button', { class: 'chat-peek', type: 'button', 'aria-label': 'Open chat', onclick: () => openChat() });
  ui.peek.inert = true;
  root.append(panel, ui.peek);
  renderAll();
}

/** A small round button that opens the chat. Screens put one in their toolbar. */
export function chatButton() {
  const badge = h('i', { class: 'chat-badge', hidden: '' });
  const btn = h('button', { class: 'icon-btn chat-btn', type: 'button', title: 'Chat (C)', 'aria-haspopup': 'dialog', 'aria-expanded': String(chat.open), 'aria-controls': 'chat-panel', 'aria-label': 'Chat', onclick: () => toggleChat(btn) }, icon('message'), badge);
  launchers.add(btn);
  paintLauncher(btn);   // not in the page yet, so paint this one directly instead of pruning it
  return btn;
}

/** main.js tells us which screen is showing, so the panel can dock where it covers the least. */
export function chatScreen(name) {
  screenName = name;
  if (root) root.dataset.screen = name;
  if (name === 'arena' && chat.open && narrow()) closeChat({ restoreFocus: false });
}

export function initChat() {
  root = document.getElementById('chat-root');
  if (!root || panel) return;
  build();

  let sig = '';
  subscribe((keys) => {
    if (!keys.includes('state')) return;
    if (!store.state) { if (chat.code) reset(null); sig = ''; return; }
    paintState();
    // names and avatars only change when someone joins or leaves, so only then is the list redrawn (scroll position kept)
    const next = players().map((p) => `${p.id}:${p.name}:${p.avatar}`).join('|');
    if (next !== sig) {
      sig = next;
      if (chat.open) { const keep = ui.log.scrollTop; const stick = nearBottom(); renderAll(); if (!stick) ui.log.scrollTop = keep; }
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && chat.open && (panel.contains(e.target) || e.target === document.body) && !document.querySelector('.modal-backdrop')) { e.preventDefault(); closeChat(); return; }
    if (e.key !== 'c' && e.key !== 'C') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const tag = (t && t.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    if (!store.session || !store.state || document.querySelector('.modal-backdrop')) return;
    e.preventDefault();
    toggleChat([...launchers].find((b) => b.isConnected));
  });

  // Keep the phone sheet above the on-screen keyboard.
  const vv = window.visualViewport;
  if (vv) {
    const fit = () => root.style.setProperty('--kb', Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) + 'px');
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
  }
}

// exposed for tests and for the lobby/arena when they need to know
export const chatState = () => ({ open: chat.open, unread: chat.unread, count: chat.items.length, code: chat.code, screen: screenName });
