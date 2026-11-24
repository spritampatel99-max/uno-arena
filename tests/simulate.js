'use strict';
/**
 * End-to-end simulation against the REAL HTTP + SSE server.
 *
 * Four scripted "browsers" create/join a room, play a complete match through the public API,
 * one of them drops its connection mid-game (→ autopilot → reconnect), then the host runs a rematch.
 * Along the way it asserts: error strings, host-only controls, hidden opponent hands,
 * card conservation (108) from every player's point of view, turn-timer fields, and basic security.
 *
 *   node tests/simulate.js
 */

const http = require('http');
const assert = require('node:assert/strict');
const { createServer } = require('../server/index');

const FAST = {
  countdownMs: 150, intermissionMs: 250, botMinMs: 15, botMaxMs: 45,
  reconnectMs: 5000, abandonMs: 20000, roomIdleMs: 60000, disconnectGraceMs: 200,
};

let base;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(base + path, {
      method,
      headers: { ...(data !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not json */ }
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}
const post = (p, b, h) => request('POST', p, b, h);

class Client {
  constructor(name, rng) {
    this.name = name;
    this.rng = rng;
    this.state = null;
    this.events = [];
    this.lastSeq = 0;
    this.sse = null;
    this.closed = false;
    this.autoplay = true;
    this.busy = false;
    this.moves = 0;
    this.violations = [];
  }

  async create() {
    const r = await post('/api/rooms', { name: this.name, avatar: 'fox' });
    assert.ok(r.json.ok, 'create room');
    Object.assign(this, { code: r.json.code, pid: r.json.pid, token: r.json.token });
  }

  async join(code, expectOk = true) {
    const r = await post('/api/rooms/join', { code, name: this.name, avatar: 'cat' });
    if (!expectOk) return r;
    assert.ok(r.json.ok, `join failed: ${JSON.stringify(r.json)}`);
    Object.assign(this, { code: r.json.code, pid: r.json.pid, token: r.json.token });
    return r;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = `${base}/api/events?code=${this.code}&pid=${this.pid}&token=${encodeURIComponent(this.token)}`;
      const req = http.get(url, (res) => {
        if (res.statusCode !== 200) return reject(new Error('SSE status ' + res.statusCode));
        assert.match(res.headers['content-type'], /text\/event-stream/);
        let buf = '';
        let first = true;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            this.onMessage(JSON.parse(line.slice(6)));
            if (first) { first = false; resolve(); }
          }
        });
        res.on('end', () => { this.closed = true; });
      });
      req.on('error', (e) => { if (!this.closed) reject(e); });
      this.sse = req;
    });
  }

  disconnect() { this.closed = true; if (this.sse) this.sse.destroy(); }

  onMessage(msg) {
    if (msg.type === 'sync' || msg.type === 'update') {
      if (msg.type === 'sync') this.lastSync = msg;
      else if (msg.chat) this.violations.push('chat history repeated in an update');
      this.state = msg.state;
      if (msg.state.game && !this.firstGame) this.firstGame = JSON.parse(JSON.stringify(msg.state.game));
      this.checkInvariants(msg);
      if (msg.events) {
        this.events.push(...msg.events);
        for (const ev of msg.events) {
          if (ev.type === 'draw' && ev.pid !== this.pid && ev.cards) this.violations.push('draw event leaked opponent cards');
          if (ev.type === 'uno_armed' && ev.pid !== this.pid) this.violations.push('uno_armed leaked');
        }
      }
      if (this.autoplay) this.schedule();
    } else if (msg.type === 'closed' || msg.type === 'kicked') {
      this.events.push(msg);
    }
  }

  checkInvariants(msg) {
    const s = msg.state;
    const raw = JSON.stringify(s);
    if (raw.includes('"hands"')) this.violations.push('state leaks hands');
    for (const p of s.players) {
      if (typeof p.cards !== 'number') this.violations.push('opponent cards not a number');
      if (p.token || p.hand) this.violations.push('player entry leaks private fields');
    }
    if (s.game && s.game.phase !== 'finished') {
      const sum = s.game.hand.length + s.players.filter((p) => p.id !== this.pid).reduce((a, p) => a + p.cards, 0) + s.game.deckCount + s.game.discardCount;
      if (sum !== 108) this.violations.push(`conservation: ${sum} != 108`);
    }
  }

  schedule() {
    if (this.busy) return;
    this.busy = true;
    setImmediate(async () => {
      try { await this.act(); } catch (e) { this.violations.push('act error: ' + e.message); } finally { this.busy = false; }
    });
  }

  async send(type, args = {}) {
    return post('/api/action', { code: this.code, pid: this.pid, token: this.token, type, ...args });
  }

  async act() {
    const s = this.state;
    if (!s || s.status !== 'PLAYING' || !s.game || s.game.phase !== 'playing') return;
    const g = s.game;
    const me = s.players.find((p) => p.id === this.pid);
    // UNO: arm at 2 cards, declare / catch for others
    if (g.hand.length <= 2 && me && !me.uno?.called && g.hand.length > 0 && g.turnId === this.pid && this.rng() < 0.8) {
      await this.send('uno');
    }
    for (const p of s.players) {
      if (p.id !== this.pid && p.uno && p.uno.catchUntil && this.rng() < 0.5) await this.send('catch', { target: p.id });
    }
    if (g.turnId !== this.pid) return;
    await sleep(1 + Math.floor(this.rng() * 4));
    let res;
    if (g.canDraw && g.playable.length === 0) res = await this.send('draw');
    else if (g.canPass && g.playable.length === 0) res = await this.send('pass');
    else if (g.playable.length) {
      const id = g.playable[Math.floor(this.rng() * g.playable.length)];
      const card = g.hand.find((c) => c.id === id);
      const colors = ['red', 'blue', 'yellow', 'green'];
      res = await this.send('play', { cardId: id, color: card.color ? undefined : colors[Math.floor(this.rng() * 4)] });
    }
    if (res && !res.json.ok && !['NOT_YOUR_TURN', 'NOT_PLAYING'].includes(res.json.error)) {
      this.violations.push('unexpected rejection ' + JSON.stringify(res.json));
    }
    this.moves += 1;
  }

  async waitFor(pred, ms = 20000, label = 'condition') {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (this.state && pred(this.state)) return this.state;
      await sleep(10);
    }
    throw new Error(`timed out waiting for ${label}; status=${this.state && this.state.status}`);
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const app = createServer({ env: {}, config: FAST, tickMs: 25, rate: { action: 1e6, lobby: 1e6, read: 1e6 } });
  const addr = await app.start(0, '127.0.0.1');
  base = `http://127.0.0.1:${addr.port}`;
  const ok = (label) => console.log('  ✓ ' + label);
  console.log(`Server on ${base}`);

  // ---------------------------------------------------------------- static + security
  let r = await request('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-security-policy'] || '', /default-src 'self'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  r = await request('GET', '/healthz');
  assert.equal(r.json.ok, true);
  r = await request('GET', '/..%2f..%2f..%2fetc%2fpasswd');
  assert.ok(!/root:/.test(r.text), 'no file outside public/ is ever served');
  r = await request('GET', '/%2e%2e/package.json');
  assert.ok([400, 403, 404].includes(r.status) && !/uno-arena/.test(r.text), 'dot-dot blocked');
  r = await post('/api/rooms', 'not json');
  assert.equal(r.json.error, 'BAD_REQUEST');
  r = await request('POST', '/api/rooms', JSON.stringify({ name: 'Mallory' }), { 'Content-Type': 'text/plain' });
  assert.equal(r.json.error, 'BAD_REQUEST', 'non-JSON content type refused');
  r = await post('/api/rooms', { name: 'Mallory' }, { Origin: 'http://evil.example' });
  assert.equal(r.json.error, 'BAD_REQUEST', 'cross-origin POST refused');
  try {
    r = await post('/api/rooms', { name: 'x'.repeat(20000) });
    assert.equal(r.status, 413, 'oversized body refused');
  } catch (e) {
    if (e.code === 'ERR_ASSERTION') throw e; // a reset connection is also an acceptable refusal
  }
  ok('static serving, security headers, traversal / origin / content-type / size checks');

  // ---------------------------------------------------------------- lobby errors
  r = await post('/api/rooms/join', { code: '', name: 'Zed' });
  assert.equal(r.json.message, 'PLEASE ENTER A ROOM CODE.');
  r = await post('/api/rooms/join', { code: 'ab', name: 'Zed' });
  assert.equal(r.json.message, 'INVALID ROOM CODE.');
  r = await post('/api/rooms/join', { code: 'ZZZZZZ', name: 'Zed' });
  assert.equal(r.json.message, 'ROOM NOT FOUND.');
  assert.equal(r.status, 404);
  r = await post('/api/rooms', { name: '!' });
  assert.equal(r.json.error, 'NAME_REQUIRED');
  ok('lobby error strings match the spec');

  // ---------------------------------------------------------------- room + joins
  const rng = mulberry32(99);
  const host = new Client('Host', rng);
  await host.create();
  assert.match(host.code, /^[A-HJKMNP-Z2-9]{6}$/);
  const others = [new Client('Ann', rng), new Client('Ann', rng), new Client('Cleo', rng)];
  await host.connect();
  for (const c of others) { await c.join(host.code.toLowerCase().replace(/(...)(...)/, '$1 $2')); await c.connect(); }
  const all = [host, ...others];
  await host.waitFor((s) => s.players.length === 4, 3000, '4 players');
  assert.deepEqual(host.state.players.map((p) => p.name), ['Host', 'Ann', 'Ann 2', 'Cleo']);
  assert.equal(host.state.players.filter((p) => p.isHost).length, 1);
  const extra = new Client('Late', rng);
  r = await extra.join(host.code, false);
  assert.equal(r.json.message, 'THIS ROOM IS FULL.');
  ok('create / join (spaced lowercase code), duplicate names, full room');

  // ---------------------------------------------------------------- host-only controls
  r = await others[0].send('settings', { settings: { stacking: true } });
  assert.equal(r.json.error, 'FORBIDDEN');
  r = await others[0].send('start');
  assert.equal(r.json.error, 'FORBIDDEN');
  r = await others[0].send('kick', { target: host.pid });
  assert.equal(r.json.error, 'FORBIDDEN');
  r = await host.send('settings', { settings: { turnSeconds: 31 } });
  assert.equal(r.json.error, 'BAD_SETTINGS');
  r = await host.send('settings', { settings: { winningScore: 100, startingCards: 5, stacking: true, jumpIn: true, drawUntilPlayable: false } });
  assert.ok(r.json.ok);
  await others[2].waitFor((s) => s.settings.winningScore === 100 && s.settings.stacking, 3000, 'settings broadcast');
  r = await host.send('settings', { settings: { maxPlayers: 2 } });
  assert.equal(r.json.error, 'TOO_MANY_PLAYERS');
  ok('host-only controls, settings validated + broadcast');

  // kick + rejoin + bot
  r = await host.send('kick', { target: others[2].pid });
  assert.ok(r.json.ok);
  await host.waitFor((s) => s.players.length === 3, 3000, 'kick applied');
  r = await others[2].send('settings', {});
  assert.equal(r.json.error, 'AUTH', 'kicked token is dead');
  const cleo2 = new Client('Cleo', rng);
  await cleo2.join(host.code);
  await cleo2.connect();
  others[2] = cleo2; all[3] = cleo2;
  await host.waitFor((s) => s.players.length === 4, 3000, 'rejoin');
  ok('kick revokes the session; kicked player can rejoin by code');

  // ---------------------------------------------------------------- play a full match
  for (const c of all) c.autoplay = true;
  r = await host.send('start');
  assert.ok(r.json.ok);
  await host.waitFor((s) => s.status === 'STARTING', 3000, 'countdown');
  await host.waitFor((s) => s.status === 'PLAYING' && s.game, 5000, 'game start');
  const late = new Client('Latecomer', rng);
  r = await late.join(host.code, false);
  assert.match(r.json.message, /ALREADY STARTED/);
  ok('countdown → PLAYING, late join refused with a message');

  // sanity on first view
  // (use the first view the server ever sent: autoplaying clients may already have moved by now)
  const g0 = host.firstGame;
  // 5 cards were dealt; a Draw Two as the starter card gives the first player 2 more before anyone has moved
  assert.ok(g0.hand.length === 5 || g0.hand.length === 7, `dealt hand was ${g0.hand.length}`);
  assert.equal(g0.turnSeconds, 30);
  assert.ok(g0.turnEndsAt > 0);

  // reactions over the real wire: allowlisted ones are broadcast, free text is refused
  const em = await host.send('emote', { id: 'gg' });
  assert.ok(em.json.ok, 'emote accepted');
  const bad = await host.send('emote', { id: '<img src=x onerror=alert(1)>' });
  assert.equal(bad.json.error, 'BAD_REQUEST');
  ok('reactions: allowlist enforced');

  // table chat over the real wire: delivered to everyone as plain text, sender identity comes from the session, limits enforced, history on reconnect
  const said = '<b>hi</b> ready? ' + 'x'.repeat(10);
  const cm = await host.send('chat', { text: said, name: 'Admin', from: 'someone-else' });
  assert.ok(cm.json.ok, 'chat accepted');
  await others[0].waitFor(() => others[0].events.some((e) => e.type === 'chat' && e.msg.text === said), 3000, 'chat delivered');
  const got = others[0].events.find((e) => e.type === 'chat' && e.msg.text === said).msg;
  assert.equal(got.pid, host.pid, 'sender is the authenticated player, not a claimed one');
  assert.notEqual(got.name, 'Admin');
  assert.equal((await host.send('chat', { text: 'y'.repeat(201) })).json.error, 'CHAT_TOO_LONG');
  assert.equal((await host.send('chat', { text: '   ' })).json.ok, false, 'blank message refused');
  assert.equal((await host.send('chat', { text: 'too soon' })).json.error, 'RATE_LIMITED', 'back-to-back message refused');
  assert.equal((await others[0].send('chat_mode', { on: false })).json.ok, false, 'only the host can switch chat off');
  ok('chat: plain text delivered, identity from session, length and rate limits, host-only switch');

  // mid-game: player 3 loses connection, autopilot must keep the game moving, then reconnects
  await host.waitFor((s) => s.game && s.game.round >= 1 && s.game.discardCount > 3, 15000, 'some plays');
  const dropped = others[1];
  dropped.autoplay = false;
  dropped.disconnect();
  await host.waitFor((s) => s.players.find((p) => p.id === dropped.pid && !p.connected), 4000, 'disconnect published');
  ok('disconnect is published to the room');
  const movesBefore = host.state.game.discardCount;
  await host.waitFor((s) => s.game && (s.game.discardCount !== movesBefore || s.status === 'COMPLETED'), 8000, 'game continues on autopilot');
  const back = new Client('Ann', rng);
  Object.assign(back, { code: dropped.code, pid: dropped.pid, token: dropped.token });
  await back.connect();
  await host.waitFor((s) => s.players.find((p) => p.id === dropped.pid && p.connected), 4000, 'reconnected');
  assert.ok(back.state.game || back.state.status === 'COMPLETED', 'reconnect restores full state');
  assert.ok(back.lastSync && (back.lastSync.chat || []).some((m) => m.text === said), 'reconnect restores chat history');
  back.autoplay = true;
  others[1] = back; all[2] = back;
  ok('reconnect restores state; autopilot kept the game moving');

  await host.waitFor((s) => s.status === 'COMPLETED', 180000, 'match completion');
  const results = host.state.results;
  assert.ok(results, 'results present');
  assert.equal(results.standings.length, 4);
  assert.equal(results.standings[0].isWinner, true);
  assert.ok(results.standings[0].score >= 100);
  assert.deepEqual(results.standings.map((s) => s.rank), [1, 2, 3, 4]);
  for (const row of results.standings) {
    for (const k of ['name', 'avatar', 'score', 'cardsPlayed', 'cardsDrawn', 'specialCards']) assert.ok(k in row, 'scoreboard field ' + k);
  }
  // dashboard data: seat order and a cumulative score timeline that agrees with the final standings
  assert.deepEqual(results.standings.map((s) => s.seat).sort(), [0, 1, 2, 3], 'every row carries its seat');
  assert.ok(Array.isArray(results.timeline) && results.timeline.length === results.rounds, 'one timeline entry per round');
  const byId = new Map(results.standings.map((s) => [s.id, s]));
  let prev = {};
  results.timeline.forEach((t, i) => {
    assert.equal(t.round, i + 1, 'timeline rounds are in order');
    for (const s of results.standings) {
      assert.ok(t.scores[s.id] >= (prev[s.id] || 0), 'cumulative scores never go down');
    }
    prev = t.scores;
  });
  for (const [id, row] of byId) assert.equal(prev[id], row.score, 'last timeline entry equals the final score');
  ok(`match finished after ${host.state.game.round} round(s); winner ${results.standings[0].name} with ${results.standings[0].score}`);

  for (const c of all) assert.deepEqual(c.violations, [], `${c.name} violations`);
  ok('no hidden-hand leaks, card conservation held on every update for every player');

  // ---------------------------------------------------------------- results controls
  r = await others[0].send('rematch');
  assert.equal(r.json.error, 'FORBIDDEN');
  r = await host.send('rematch');
  assert.ok(r.json.ok);
  await host.waitFor((s) => s.status === 'PLAYING' && s.game && s.game.round === 1, 5000, 'rematch');
  ok('rematch (host only) starts a fresh match');
  for (const c of all) c.autoplay = false;
  await sleep(100);

  // host leaves mid-game → host transfers, game continues
  const hostId = host.pid;
  r = await host.send('leave');
  assert.ok(r.json.ok);
  host.disconnect();
  await others[0].waitFor((s) => s.hostId !== hostId && s.players.length === 3, 4000, 'host transfer');
  ok('host leaving mid-game transfers host safely');

  // everybody else leaves → room closes
  for (const c of others) await c.send('leave');
  await sleep(200);
  r = await post('/api/rooms/resume', { code: host.code, pid: others[0].pid, token: others[0].token });
  assert.ok(!r.json.ok, 'room is gone once everybody left');
  ok('room closes after the last human leaves');

  for (const c of all) c.disconnect();
  await app.stop();

  // ---------------------------------------------------------------- real rate limiter (default limits)
  const strict = createServer({ env: {}, config: FAST, tickMs: 25 });
  const sAddr = await strict.start(0, '127.0.0.1');
  base = `http://127.0.0.1:${sAddr.port}`;
  let limited = 0;
  for (let i = 0; i < 25; i++) {
    const res = await post('/api/rooms/join', { code: 'ZZZZZZ', name: 'Spam' });
    if (res.status === 429) limited += 1;
  }
  assert.ok(limited >= 10, `lobby rate limit kicked in (${limited} of 25 limited)`);
  await strict.stop();
  ok('per-IP rate limiting returns 429 under spam');

  console.log('\nSIMULATION PASSED');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('\nSIMULATION FAILED\n', err && err.stack || err);
  process.exit(1);
});
