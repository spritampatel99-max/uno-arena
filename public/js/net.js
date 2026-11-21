// Network layer: JSON API calls + the Server-Sent Events stream (with reconnection).
import { store, setConn, setState, setSession, serverNow } from './store.js';

export const NET_ERROR = { ok: false, error: 'NETWORK', message: 'CANNOT REACH THE SERVER. CHECK YOUR CONNECTION.' };

export async function api(path, body) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      cache: 'no-store',
    });
    const json = await res.json().catch(() => null);
    if (!json) return NET_ERROR;
    return json;
  } catch (_) {
    return NET_ERROR;
  }
}

export async function getStats() {
  try {
    const res = await fetch('/api/stats', { cache: 'no-store' });
    const json = await res.json();
    return json && json.ok ? json : null;
  } catch (_) { return null; }
}

export function action(type, args = {}) {
  const s = store.session;
  if (!s) return Promise.resolve({ ok: false, error: 'AUTH', message: 'YOUR SESSION HAS EXPIRED. REJOIN THE ROOM.' });
  return api('/api/action', { code: s.code, pid: s.pid, token: s.token, type, ...args });
}

export async function createRoom(name, avatar) {
  const res = await api('/api/rooms', { name, avatar });
  if (res.ok) setSession({ code: res.code, pid: res.pid, token: res.token });
  return res;
}

export async function joinRoom(code, name, avatar) {
  const res = await api('/api/rooms/join', { code, name, avatar });
  if (res.ok) setSession({ code: res.code, pid: res.pid, token: res.token });
  return res;
}

export async function resume(session) {
  return api('/api/rooms/resume', session);
}

/**
 * Opens the event stream for the current session.
 * handlers: { onUpdate(msg), onClosed(reason) } — `msg.events` are the (already filtered) events behind a state change.
 */
export function connectEvents(handlers) {
  let es = null;
  let stopped = false;
  let retryTimer = null;
  let watchdog = null;
  let lastSeq = -1;

  const clearTimers = () => { clearTimeout(retryTimer); clearTimeout(watchdog); };

  const arm = () => {
    clearTimeout(watchdog);
    // The server sends a heartbeat every 15 s; silence for 40 s means the link is dead.
    watchdog = setTimeout(() => { if (!stopped) { setConn('reconnecting'); open(); } }, 40000);
  };

  function open() {
    if (stopped || !store.session) return;
    clearTimeout(retryTimer);
    if (es) { es.close(); es = null; }
    const { code, pid, token } = store.session;
    setConn(store.conn === 'online' ? 'reconnecting' : (store.conn === 'idle' ? 'connecting' : store.conn));
    es = new EventSource(`/api/events?code=${encodeURIComponent(code)}&pid=${encodeURIComponent(pid)}&token=${encodeURIComponent(token)}`);
    es.onopen = () => { setConn('online'); arm(); };
    es.onmessage = (ev) => {
      arm();
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === 'sync') {
        lastSeq = msg.seq;
        setConn('online');
        setState(msg.state, msg.serverTime);
        handlers.onSync && handlers.onSync(msg);
      } else if (msg.type === 'update') {
        if (msg.seq <= lastSeq) return;
        lastSeq = msg.seq;
        setState(msg.state, msg.serverTime);
        handlers.onUpdate && handlers.onUpdate(msg);
      } else if (msg.type === 'kicked') {
        handlers.onClosed && handlers.onClosed('kicked');
      } else if (msg.type === 'closed') {
        stopped = true;
        clearTimers();
        if (es) es.close();
        handlers.onClosed && handlers.onClosed(msg.reason || 'closed');
      }
    };
    es.onerror = async () => {
      if (stopped) return;
      setConn('reconnecting');
      if (es.readyState === EventSource.CLOSED) {
        // The server refused the stream (HTTP error). Find out whether the session is still valid.
        const res = await resume(store.session);
        if (stopped) return;
        if (res && !res.ok && res.error !== 'NETWORK' && res.error !== 'RATE_LIMITED') {
          stopped = true;
          clearTimers();
          handlers.onClosed && handlers.onClosed(res.error === 'ROOM_NOT_FOUND' ? 'gone' : 'auth');
          return;
        }
        retryTimer = setTimeout(open, 1500);
      }
      // readyState CONNECTING: the browser retries on its own (server sends `retry: 1500`).
    };
  }

  open();
  return {
    close() {
      stopped = true;
      clearTimers();
      if (es) es.close();
      es = null;
      setConn('idle');
    },
    now: serverNow,
  };
}
