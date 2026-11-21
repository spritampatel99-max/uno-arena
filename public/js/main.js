// UNO ARENA — client entry: router, session handling, connection banner.
import { $, h, clear, sleep } from './dom.js';
import { store, subscribe, setSession, clearRoom, setPrefs } from './store.js';
import { connectEvents, resume, action } from './net.js';
import { initFx } from './fx.js';
import { toast } from './ui.js';
import { icon } from './icons.js';
import { createWelcome } from './screens/welcome.js';
import { createRoomScreen } from './screens/room.js';
import { createArena } from './screens/arena.js';
import { createResults } from './screens/results.js';

const FACTORIES = { welcome: createWelcome, room: createRoomScreen, arena: createArena, results: createResults };
const root = $('#screen-root');

let current = null;        // { name, screen }
let events = null;         // SSE controller
let transitioning = false;
let pendingRoute = null;
let resultsTimer = null;
let banner = null;
let bannerTimer = null;

const ctx = {
  go: (name, props) => show(name, props),
  leave,
  getScreenName: () => (current ? current.name : null),
};

// ------------------------------------------------------------------ screen switching
async function show(name, props = {}) {
  if (transitioning) { pendingRoute = { name, props }; return; }
  if (current && current.name === name && !props.force) { return; }
  transitioning = true;
  try {
    if (current) {
      const old = current;
      old.screen.el.classList.add('leave');
      await sleep(old.name === 'arena' ? 200 : 240);
      try { old.screen.unmount && old.screen.unmount(); } catch (e) { console.error(e); }
      old.screen.el.remove();
    }
    clear(root);
    const screen = FACTORIES[name](ctx, props);
    current = { name, screen };
    screen.el.classList.add('screen', 'enter');
    screen.el.dataset.screen = name;
    root.append(screen.el);
    screen.mount && screen.mount();
    document.title = name === 'arena' ? 'UNO ARENA — In match' : 'UNO ARENA — Play together. Outsmart everyone.';
  } finally {
    transitioning = false;
    if (pendingRoute) { const p = pendingRoute; pendingRoute = null; show(p.name, p.props); }
  }
}

/** Decide which screen the current server state belongs to. */
function routeForState() {
  const st = store.state;
  if (!st) return null;
  switch (st.status) {
    case 'WAITING':
    case 'STARTING': return 'room';
    case 'PLAYING': return 'arena';
    case 'COMPLETED': return 'results';
    default: return null;
  }
}

function applyRoute() {
  const target = routeForState();
  if (!target) return;
  const name = current ? current.name : null;
  if (target === name) { clearTimeout(resultsTimer); resultsTimer = null; return; }
  if (target === 'results' && name === 'arena') {
    // let the arena show the "match finished" moment before the scoreboard
    if (!resultsTimer) resultsTimer = setTimeout(() => { resultsTimer = null; if (routeForState() === 'results') show('results'); }, 2600);
    return;
  }
  clearTimeout(resultsTimer); resultsTimer = null;
  show(target);
}

// ------------------------------------------------------------------ connection / session
function startEvents() {
  if (events) events.close();
  events = connectEvents({
    onSync: (msg) => { applyRoute(); if (current && current.screen.onSync) current.screen.onSync(msg); },
    onUpdate: (msg) => {
      applyRoute();
      if (current && current.screen.onEvents) current.screen.onEvents(msg);
    },
    onClosed: (reason) => {
      const text = {
        kicked: 'YOU WERE REMOVED FROM THE ROOM BY THE HOST.',
        gone: 'THAT ROOM IS NO LONGER AVAILABLE.',
        auth: 'YOUR SESSION HAS EXPIRED. REJOIN THE ROOM.',
        empty: 'THE ROOM HAS CLOSED.',
        idle: 'THE ROOM CLOSED DUE TO INACTIVITY.',
        timeout: 'YOU WERE DISCONNECTED FOR TOO LONG AND REMOVED FROM THE ROOM.',
      }[reason];
      if (events) { events.close(); events = null; }
      clearRoom();
      if (text) toast(text, 'error', 5200);
      show('welcome');
    },
  });
}

async function leave() {
  const hadRoom = !!store.session;
  if (hadRoom) await action('leave');
  if (events) { events.close(); events = null; }
  clearRoom();
  show('welcome');
}

/** Called by the welcome/room screens after creating or joining a room. */
function attach() {
  startEvents();
}
ctx.attach = attach;

subscribe((keys) => { if (keys.includes('conn')) paintConn(); });

function paintConn() {
  clearTimeout(bannerTimer);
  if (store.conn === 'reconnecting') {
    bannerTimer = setTimeout(() => {
      if (banner || store.conn !== 'reconnecting') return;
      banner = h('div', { class: 'conn-banner', role: 'status' }, h('span', { class: 'spin' }), 'Connection lost — reconnecting…');
      document.getElementById('app').append(banner);
    }, 1200);
  } else if (banner) {
    banner.remove(); banner = null;
  }
}

// ------------------------------------------------------------------ boot
async function boot() {
  setPrefs({}); // applies the reduce-motion class and keeps sound OFF at startup
  initFx(document.getElementById('fx'));

  const params = new URLSearchParams(location.search);
  const invite = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

  if (store.session) {
    root.append(h('div', { class: 'splash' }, h('div', { class: 'splash-spin' }), h('p', { class: 'label' }, 'Rejoining your room…')));
    const res = await resume(store.session);
    if (res.ok) {
      startEvents();
      return;
    }
    if (res.error !== 'NETWORK') clearRoom();
  }
  await show('welcome', { invite });
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.activeElement && document.activeElement.blur && document.activeElement.blur();
});

boot().catch((err) => {
  console.error(err);
  root.append(h('div', { style: { padding: '24px' } }, 'Something went wrong while starting UNO ARENA. Please reload the page.'));
});
