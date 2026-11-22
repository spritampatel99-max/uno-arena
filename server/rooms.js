'use strict';
/**
 * UNO ARENA — room manager.
 *
 * Owns rooms, players, presence, host controls, timers (via `tick`) and the
 * per-player filtered views that are pushed over Server-Sent Events. All game
 * rules live in engine.js; this layer decides *who may do what and when*.
 *
 * The manager never calls setInterval itself: the HTTP server drives `tick()`
 * and tests drive it with a fake clock, so everything here is deterministic.
 */

const crypto = require('crypto');
const E = require('./engine');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const AVATARS = ['fox', 'bunny', 'panda', 'cat', 'penguin', 'dragon'];
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]{1,15}$/u;
const MAX_ROOMS = 500;
// Quick reactions. A fixed allowlist, so nobody can type free text at another player.
const EMOTES = ['gg', 'nice', 'wow', 'haha', 'thanks', 'think', 'fire', 'great'];
const EMOTE_REPLY = { gg: 'gg', nice: 'thanks', wow: 'think', haha: 'haha', thanks: 'nice', think: 'wow', fire: 'wow', great: 'thanks' };
const EMOTE_BURST = 3;        // at most 3 reactions...
const EMOTE_WINDOW_MS = 6000; // ...per 6 seconds per player
const EMOTE_GAP_MS = 700;     // and never closer together than this

const MESSAGES = {
  EMPTY_CODE: 'PLEASE ENTER A ROOM CODE.',
  INVALID_CODE: 'INVALID ROOM CODE.',
  ROOM_NOT_FOUND: 'ROOM NOT FOUND.',
  ROOM_FULL: 'THIS ROOM IS FULL.',
  ALREADY_PLAYING: 'THIS MATCH HAS ALREADY STARTED. YOU CAN JOIN WHEN THE HOST OPENS A NEW ROOM.',
  ROOM_NOT_OPEN: 'THIS ROOM IS NOT ACCEPTING NEW PLAYERS RIGHT NOW.',
  NAME_REQUIRED: 'ENTER A NICKNAME (2–16 LETTERS OR NUMBERS).',
  FORBIDDEN: 'ONLY THE HOST CAN DO THAT.',
  NOT_YOUR_TURN: 'IT IS NOT YOUR TURN.',
  ILLEGAL_MOVE: 'THAT CARD CANNOT BE PLAYED NOW.',
  WILD4_ILLEGAL: 'WILD DRAW FOUR ONLY WORKS WHEN YOU HAVE NO CARD OF THE CURRENT COLOUR.',
  MUST_STACK_OR_DRAW: 'STACK A MATCHING DRAW CARD OR DRAW THE PENALTY.',
  ONLY_DRAWN_CARD: 'YOU CAN ONLY PLAY THE CARD YOU JUST DREW.',
  COLOR_REQUIRED: 'CHOOSE A COLOUR FOR YOUR WILD CARD.',
  NOT_IN_HAND: 'THAT CARD IS NOT IN YOUR HAND.',
  NOT_ENOUGH_PLAYERS: 'AT LEAST 2 PLAYERS ARE NEEDED.',
  TOO_MANY_PLAYERS: 'MORE PLAYERS ARE IN THE ROOM THAN THAT LIMIT ALLOWS.',
  BAD_SETTINGS: 'THOSE SETTINGS ARE NOT VALID.',
  RATE_LIMITED: 'SLOW DOWN A LITTLE.',
  SERVER_BUSY: 'THE SERVER IS BUSY. TRY AGAIN SHORTLY.',
  BAD_REQUEST: 'THAT REQUEST WAS NOT UNDERSTOOD.',
  AUTH: 'YOUR SESSION HAS EXPIRED. REJOIN THE ROOM.',
  NOTHING_TO_CATCH: 'TOO LATE — NOTHING TO CATCH.',
  TOO_LATE: 'TOO LATE TO CALL UNO.',
  ALREADY_CALLED: 'UNO ALREADY CALLED.',
  NOT_NEEDED: 'YOU CAN ONLY CALL UNO WITH 1 OR 2 CARDS.',
  ALREADY_DRAWN: 'YOU HAVE ALREADY DRAWN THIS TURN.',
  CANNOT_PASS: 'DRAW A CARD BEFORE PASSING.',
  CANNOT_CATCH_SELF: 'YOU CANNOT CATCH YOURSELF.',
  WRONG_STATE: 'THAT IS NOT POSSIBLE RIGHT NOW.',
  NOT_PLAYING: 'THE GAME IS NOT IN PROGRESS.',
  NOT_IN_GAME: 'YOU ARE NOT IN THIS GAME.',
  BOT_NOT_FOUND: 'THAT BOT IS NOT IN THE ROOM.',
};
const msg = (code) => MESSAGES[code] || 'SOMETHING WENT WRONG.';
const fail = (error) => ({ ok: false, error, message: msg(error) });

function configFromEnv(env = process.env) {
  const num = (k, d) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  return {
    reconnectMs: num('UNO_RECONNECT_MS', 45000),
    abandonMs: num('UNO_ABANDON_MS', 120000),
    botMinMs: num('UNO_BOT_MIN_MS', 900),
    botMaxMs: num('UNO_BOT_MAX_MS', 1900),
    countdownMs: num('UNO_COUNTDOWN_MS', 3000),
    intermissionMs: num('UNO_INTERMISSION_MS', 7000),
    roomIdleMs: num('UNO_ROOM_IDLE_MS', 600000),
    disconnectGraceMs: num('UNO_DISCONNECT_GRACE_MS', 2000),
  };
}

function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function normalizeCode(raw) {
  return String(raw == null ? '' : raw).toUpperCase().replace(/[\s\-_]/g, '');
}

function cleanName(raw) {
  const s = String(raw == null ? '' : raw).normalize('NFC').replace(/\s+/g, ' ').trim();
  return NAME_RE.test(s) ? s : null;
}

class RoomManager {
  constructor({ config = {}, rng = Math.random, now = () => Date.now() } = {}) {
    this.cfg = { ...configFromEnv({}), ...config };
    this.rng = rng;
    this.now = now;
    this.rooms = new Map();
  }

  // ------------------------------------------------------------ helpers

  rand(min, max) { return min + this.rng() * Math.max(0, max - min); }

  newCode() {
    for (let tries = 0; tries < 200; tries++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  newId() { return crypto.randomBytes(6).toString('hex'); }
  newToken() { return crypto.randomBytes(24).toString('base64url'); }

  uniqueName(room, name) {
    const taken = new Set(this.active(room).map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; n < 100; n++) {
      const suffix = ' ' + n;
      const candidate = name.slice(0, 16 - suffix.length) + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return name;
  }

  active(room) { return [...room.players.values()].filter((p) => !p.left); }
  humans(room) { return this.active(room).filter((p) => !p.isBot); }

  makePlayer(room, { name, avatar, isBot = false }) {
    const now = this.now();
    const p = {
      id: this.newId(),
      token: isBot ? null : this.newToken(),
      name: this.uniqueName(room, name),
      avatar: isBot ? 'bot' : (AVATARS.includes(avatar) ? avatar : AVATARS[Math.floor(this.rng() * AVATARS.length)]),
      isBot,
      connected: true, // humans get a short grace period to open their event stream
      conns: new Set(),
      lostAt: isBot ? 0 : now,
      disconnectedAt: 0,
      joinedAt: now,
      timeouts: 0,
      afk: false,
      left: false,
    };
    room.players.set(p.id, p);
    return p;
  }

  getRoom(code) {
    const c = normalizeCode(code);
    return this.rooms.get(c) || null;
  }

  auth(code, pid, token) {
    const room = this.getRoom(code);
    if (!room) return { error: 'ROOM_NOT_FOUND' };
    const p = room.players.get(pid);
    if (!p || p.left || p.isBot || !tokenEquals(p.token, token)) return { error: 'AUTH' };
    return { room, player: p };
  }

  // ------------------------------------------------------------ lobby API

  createRoom({ name, avatar }) {
    const clean = cleanName(name);
    if (!clean) return fail('NAME_REQUIRED');
    if (this.rooms.size >= MAX_ROOMS) return fail('SERVER_BUSY');
    const code = this.newCode();
    if (!code) return fail('SERVER_BUSY');
    const now = this.now();
    const room = {
      code,
      createdAt: now,
      status: 'WAITING',
      hostId: null,
      players: new Map(),
      settings: { ...E.DEFAULT_SETTINGS },
      match: null,
      seq: 0,
      countdownEndsAt: 0,
      intermissionEndsAt: 0,
      lastActivity: now,
      noHumansSince: 0,
      botDue: null,
      catchDue: new Map(),
      recent: [],
    };
    const host = this.makePlayer(room, { name: clean, avatar });
    room.hostId = host.id;
    this.rooms.set(code, room);
    return { ok: true, code, pid: host.id, token: host.token };
  }

  checkCode(raw) {
    const code = normalizeCode(raw);
    if (!code) return { error: 'EMPTY_CODE' };
    if (code.length !== CODE_LENGTH || ![...code].every((ch) => CODE_ALPHABET.includes(ch))) return { error: 'INVALID_CODE' };
    const room = this.rooms.get(code);
    if (!room) return { error: 'ROOM_NOT_FOUND' };
    return { room, code };
  }

  joinRoom({ code, name, avatar }) {
    const chk = this.checkCode(code);
    if (chk.error) return fail(chk.error);
    const room = chk.room;
    if (room.status === 'CLOSED') return fail('ROOM_NOT_FOUND');
    if (room.status === 'PLAYING' || room.status === 'STARTING') return fail('ALREADY_PLAYING');
    if (room.status !== 'WAITING') return fail('ROOM_NOT_OPEN');
    if (this.active(room).length >= room.settings.maxPlayers) return fail('ROOM_FULL');
    const clean = cleanName(name);
    if (!clean) return fail('NAME_REQUIRED');
    const p = this.makePlayer(room, { name: clean, avatar });
    room.lastActivity = this.now();
    this.emit(room, [{ type: 'player_joined', pid: p.id, name: p.name }]);
    return { ok: true, code: room.code, pid: p.id, token: p.token };
  }

  resume({ code, pid, token }) {
    const a = this.auth(code, pid, token);
    if (a.error) return fail(a.error);
    return { ok: true, code: a.room.code, pid };
  }

  // ------------------------------------------------------------ SSE subscriptions

  subscribe({ code, pid, token }, conn) {
    const a = this.auth(code, pid, token);
    if (a.error) return fail(a.error);
    const { room, player } = a;
    player.conns.add(conn);
    player.lostAt = 0;
    const wasDisconnected = !player.connected;
    player.connected = true;
    player.disconnectedAt = 0;
    conn.send({ type: 'sync', seq: room.seq, serverTime: this.now(), state: this.viewFor(room, pid) });
    if (wasDisconnected) this.emit(room, [{ type: 'player_reconnected', pid, name: player.name }]);
    return {
      ok: true,
      unsubscribe: () => {
        player.conns.delete(conn);
        if (player.conns.size === 0) player.lostAt = this.now();
      },
    };
  }

  connectedCount() {
    let n = 0;
    for (const room of this.rooms.values()) for (const p of room.players.values()) if (!p.left && p.conns.size > 0) n += 1;
    return n;
  }

  stats() {
    let playing = 0;
    for (const r of this.rooms.values()) if (r.status === 'PLAYING') playing += 1;
    return { online: this.connectedCount(), rooms: this.rooms.size, playing };
  }

  // ------------------------------------------------------------ views

  viewFor(room, pid) {
    const now = this.now();
    const m = room.match;
    const roster = this.active(room).sort((a, b) => a.joinedAt - b.joinedAt);
    const players = roster.map((p) => {
      const inGame = m && m.hands[p.id];
      const handLen = inGame ? m.hands[p.id].length : 0;
      const u = inGame ? m.uno[p.id] : null;
      return {
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        isBot: p.isBot,
        isHost: p.id === room.hostId,
        connected: p.connected,
        afk: p.afk,
        score: m ? (m.scores[p.id] || 0) : 0,
        cards: handLen,
        uno: u ? { called: handLen <= 1 && u.called, catchUntil: handLen === 1 && !u.called && u.vulnerableUntil > now ? u.vulnerableUntil : 0 } : null,
      };
    });
    const view = {
      code: room.code,
      status: room.status,
      hostId: room.hostId,
      me: pid,
      seq: room.seq,
      serverTime: now,
      settings: room.settings,
      players,
      countdownEndsAt: room.status === 'STARTING' ? room.countdownEndsAt : 0,
      recent: room.recent,
      game: null,
      results: null,
    };
    if (m && (room.status === 'PLAYING' || room.status === 'COMPLETED') && m.phase !== 'idle') {
      const mine = m.hands[pid];
      const top = E.topCard(m);
      const isTurn = m.phase === 'playing' && E.currentId(m) === pid;
      view.game = {
        round: m.round,
        phase: m.phase,
        dir: m.dir,
        activeColor: m.activeColor,
        pending: m.pending,
        turnId: m.phase === 'playing' ? E.currentId(m) : null,
        turnSeq: m.turnSeq,
        turnEndsAt: m.phase === 'playing' ? m.turnEndsAt : 0,
        turnSeconds: m.settings.turnSeconds,
        turnOrder: m.order.slice(),
        deckCount: m.deck.length,
        pile: m.discard.slice(-4),
        discardCount: m.discard.length,
        startedAt: m.startedAt,
        hand: mine ? mine.slice() : [],
        playable: isTurn ? E.playableIds(m, pid) : [],
        jumpIn: mine ? E.jumpInIds(m, pid) : [],
        canDraw: isTurn ? E.canDraw(m, pid) : false,
        canPass: isTurn ? E.canPass(m, pid) : false,
        drawnCardId: m.drawn && m.drawn.pid === pid ? m.drawn.cardId : null,
        roundResult: m.roundResult,
        intermissionEndsAt: m.phase === 'round_over' ? room.intermissionEndsAt : 0,
      };
    }
    if (m && m.phase === 'finished') view.results = this.buildResults(room);
    return view;
  }

  buildResults(room) {
    const m = room.match;
    const rows = m.seats.map((pid) => {
      const p = room.players.get(pid);
      const st = m.stats[pid];
      return {
        id: pid,
        name: p ? p.name : 'Player',
        avatar: p ? p.avatar : 'bot',
        isBot: p ? p.isBot : false,
        left: !m.order.includes(pid),
        score: m.scores[pid] || 0,
        cardsPlayed: st.played,
        cardsDrawn: st.drawn,
        specialCards: st.special,
        unoCalls: st.unos,
        penalties: st.penalties,
        roundsWon: m.history.filter((h) => h.winnerId === pid).length,
        isWinner: pid === m.winnerId,
      };
    });
    rows.sort((a, b) => (b.isWinner - a.isWinner) || (b.score - a.score) || (a.left - b.left) || (b.cardsPlayed - a.cardsPlayed));
    rows.forEach((r, i) => { r.rank = i + 1; });
    return {
      winnerId: m.winnerId,
      reason: m.endReason,
      rounds: m.round,
      winningScore: m.settings.winningScore,
      durationMs: (m.endedAt || this.now()) - m.startedAt,
      standings: rows,
    };
  }

  filterEvent(ev, pid) {
    if (ev.type === 'uno_armed') return ev.pid === pid ? ev : null;
    if (ev.type === 'draw' && ev.pid !== pid) {
      const { cards, ...rest } = ev; // eslint-disable-line no-unused-vars
      return rest;
    }
    if (ev.type === 'kicked') return ev;
    return ev;
  }

  publicEvent(ev) {
    return this.filterEvent(ev, null);
  }

  /** Push a state update (plus the events that caused it) to everyone in the room. */
  emit(room, events = []) {
    room.seq += 1;
    const stamped = events.map((e) => ({ ...e, seq: room.seq }));
    for (const e of stamped) {
      const pub = this.publicEvent(e);
      if (pub && LOGGED.has(pub.type)) {
        room.recent.push(pub);
        if (room.recent.length > 14) room.recent.shift();
      }
    }
    const serverTime = this.now();
    for (const p of room.players.values()) {
      if (p.left || p.conns.size === 0) continue;
      const evs = stamped.map((e) => this.filterEvent(e, p.id)).filter(Boolean);
      const payload = { type: 'update', seq: room.seq, serverTime, events: evs, state: this.viewFor(room, p.id) };
      for (const c of p.conns) {
        try { c.send(payload); } catch (_) { /* connection dropped; cleanup happens on close */ }
      }
    }
  }

  // ------------------------------------------------------------ actions

  action({ code, pid, token, type, ...args }) {
    const a = this.auth(code, pid, token);
    if (a.error) return fail(a.error);
    const { room, player } = a;
    const now = this.now();
    room.lastActivity = now;
    const handler = ACTIONS[type];
    if (!handler) return fail('BAD_REQUEST');
    const res = handler.call(this, room, player, args, now);
    return res;
  }

  isHost(room, player) { return room.hostId === player.id; }

  /** Bots sometimes answer a reaction, or say "gg" when a round ends. Delivered later from tick(). */
  queueBotEmote(room, id, delayMin, delayMax, exceptId = null) {
    const bots = this.active(room).filter((p) => p.isBot && p.id !== exceptId);
    if (!bots.length) return;
    const bot = bots[Math.floor(this.rng() * bots.length)];
    (room.botEmotes || (room.botEmotes = [])).push({ at: this.now() + this.rand(delayMin, delayMax), pid: bot.id, id });
  }

  /** Common tail for engine actions: emit, detect match end, reset bot timers. */
  afterEngine(room, res, now) {
    if (!res.ok) return fail(res.error);
    room.botDue = null;
    const events = res.events;
    for (const ev of events) {
      if (ev.type === 'round_end' && room.match.phase === 'round_over') {
        room.intermissionEndsAt = now + this.cfg.intermissionMs;
        if (this.rng() < 0.45) this.queueBotEmote(room, 'gg', 1200, 2600, ev.winnerId);
      }
      if (ev.type === 'match_end') {
        room.status = 'COMPLETED';
        room.catchDue.clear();
      }
    }
    this.emit(room, events);
    return { ok: true };
  }

  touchHuman(player) {
    player.timeouts = 0;
    if (player.afk) player.afk = false;
  }

  transferHostIfNeeded(room) {
    const host = room.players.get(room.hostId);
    if (host && !host.left) return [];
    const humans = this.humans(room).sort((a, b) => (b.connected - a.connected) || (a.joinedAt - b.joinedAt));
    if (!humans.length) return [];
    room.hostId = humans[0].id;
    return [{ type: 'host_changed', pid: humans[0].id, name: humans[0].name }];
  }

  closeRoom(room, reason) {
    if (room.status === 'CLOSED') return;
    room.status = 'CLOSED';
    for (const p of room.players.values()) {
      for (const c of p.conns) {
        try { c.send({ type: 'closed', reason }); c.close && c.close(); } catch (_) { /* ignore */ }
      }
      p.conns.clear();
    }
    this.rooms.delete(room.code);
  }

  /** Remove a player from the room entirely (leave, kick, grace expiry). */
  removeFromRoom(room, player, reason, now) {
    if (player.left) return;
    const events = [];
    const inMatch = room.match && room.match.order.includes(player.id);
    player.left = true;
    player.connected = false;
    if (inMatch && (room.status === 'PLAYING' || room.status === 'COMPLETED')) {
      if (room.status === 'PLAYING') {
        const res = E.removePlayer(room.match, player.id, now);
        if (res.ok) {
          events.push(...res.events.filter((e) => e.type !== 'player_left'));
          for (const ev of res.events) {
            if (ev.type === 'match_end') { room.status = 'COMPLETED'; room.catchDue.clear(); }
          }
          room.botDue = null;
        }
      } else if (room.match.order.includes(player.id)) {
        room.match.order.splice(room.match.order.indexOf(player.id), 1);
      }
    }
    events.unshift({ type: 'player_left', pid: player.id, name: player.name, reason });
    if (room.status === 'STARTING') {
      room.status = 'WAITING';
      room.countdownEndsAt = 0;
      room.match = null;
      events.push({ type: 'start_cancelled' });
    }
    if (room.status === 'WAITING') room.players.delete(player.id);
    if (!this.humans(room).length) {
      this.closeRoom(room, 'empty');
      return;
    }
    events.push(...this.transferHostIfNeeded(room));
    this.emit(room, events);
    for (const c of player.conns) { try { c.send({ type: 'closed', reason }); c.close && c.close(); } catch (_) { /* ignore */ } }
    player.conns.clear();
  }

  // ------------------------------------------------------------ tick (timers)

  tick(nowArg) {
    const now = nowArg == null ? this.now() : nowArg;
    for (const room of [...this.rooms.values()]) {
      try { this.tickRoom(room, now); } catch (err) {
        // A bug in one room must never take the whole server down.
        console.error('[tick] room', room.code, err && err.stack || err);
      }
    }
  }

  tickRoom(room, now) {
    if (room.status === 'CLOSED') return;

    // ---- presence: publish disconnects after a short grace, expire the long gone
    const presence = [];
    for (const p of this.humans(room)) {
      if (p.conns.size === 0 && p.connected && p.lostAt && now - p.lostAt >= this.cfg.disconnectGraceMs) {
        p.connected = false;
        p.disconnectedAt = p.lostAt;
        presence.push({ type: 'player_disconnected', pid: p.id, name: p.name });
      }
    }
    if (presence.length) {
      presence.push(...this.transferHostIfNeededForOffline(room));
      this.emit(room, presence);
    }
    for (const p of this.humans(room)) {
      if (p.connected || !p.disconnectedAt) continue;
      const away = now - p.disconnectedAt;
      const limit = room.status === 'PLAYING' ? this.cfg.abandonMs : this.cfg.reconnectMs;
      if (away >= limit) {
        this.removeFromRoom(room, p, 'timeout', now);
        if (room.status === 'CLOSED') return;
      }
    }

    // ---- idle room cleanup
    const anyConnected = this.humans(room).some((p) => p.connected);
    if (anyConnected) room.noHumansSince = 0;
    else {
      if (!room.noHumansSince) room.noHumansSince = now;
      if (now - room.noHumansSince >= this.cfg.roomIdleMs) { this.closeRoom(room, 'idle'); return; }
    }

    if (room.botEmotes && room.botEmotes.length) {
      const due = room.botEmotes.filter((b) => now >= b.at);
      if (due.length) {
        room.botEmotes = room.botEmotes.filter((b) => now < b.at);
        const out = due.filter((b) => room.players.has(b.pid) && !room.players.get(b.pid).left).map((b) => ({ type: 'emote', pid: b.pid, id: b.id }));
        if (out.length) this.emit(room, out);
      }
    }

    const m = room.match;
    if (room.status === 'STARTING') {
      if (now >= room.countdownEndsAt) this.beginMatch(room, now);
      return;
    }
    if (room.status !== 'PLAYING' || !m) return;

    if (m.phase === 'round_over') {
      if (now >= room.intermissionEndsAt) {
        room.botDue = null;
        room.catchDue.clear();
        const events = E.startRound(m, now);
        this.emit(room, events);
      }
      return;
    }
    if (m.phase !== 'playing') return;

    if (E.expireUno(m, now)) this.emit(room, []);

    // ---- bots catching humans who forgot to call UNO
    for (const p of this.active(room)) {
      const u = m.uno[p.id];
      const vulnerable = u && m.hands[p.id] && m.hands[p.id].length === 1 && !u.called && u.vulnerableUntil > now;
      if (!vulnerable || p.isBot) { room.catchDue.delete(p.id); continue; }
      let due = room.catchDue.get(p.id);
      if (!due || due.until !== u.vulnerableUntil) {
        due = {
          until: u.vulnerableUntil,
          will: this.rng() < 0.4,
          at: now + this.rand(1400, 3200),
        };
        room.catchDue.set(p.id, due);
      }
      if (due.will && now >= due.at) {
        const bot = this.active(room).find((b) => b.isBot && b.id !== p.id);
        room.catchDue.delete(p.id);
        if (bot) {
          const res = E.catchUno(m, bot.id, p.id, now);
          if (res.ok) { this.afterEngine(room, res, now); return; }
        }
      }
    }

    // ---- current player: autopilot or turn timeout
    const curId = E.currentId(m);
    const cur = room.players.get(curId);
    if (!cur) return;
    const auto = cur.isBot || cur.afk || !cur.connected;
    if (auto) {
      if (!room.botDue) room.botDue = { pid: curId, at: now + this.rand(this.cfg.botMinMs, this.cfg.botMaxMs) };
      if (room.botDue.pid !== curId) room.botDue = { pid: curId, at: now + this.rand(this.cfg.botMinMs, this.cfg.botMaxMs) };
      if (now >= room.botDue.at) {
        room.botDue = null;
        this.runBot(room, cur, now);
        return;
      }
    }
    if (m.phase === 'playing' && now >= m.turnEndsAt) {
      const res = E.timeoutTurn(m, curId, now);
      if (res.ok) {
        if (!cur.isBot) {
          cur.timeouts += 1;
          if (cur.timeouts >= 2 && !cur.afk) {
            cur.afk = true;
            res.events.push({ type: 'afk', pid: cur.id, name: cur.name });
          }
        }
        this.afterEngine(room, res, now);
      }
    }
  }

  transferHostIfNeededForOffline(room) {
    const host = room.players.get(room.hostId);
    if (host && host.connected) return [];
    const candidate = this.humans(room).filter((p) => p.connected).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (!candidate) return [];
    room.hostId = candidate.id;
    return [{ type: 'host_changed', pid: candidate.id, name: candidate.name }];
  }

  runBot(room, player, now) {
    const m = room.match;
    const move = E.chooseBotMove(m, player.id, this.rng);
    if (!move) return;
    let res;
    if (move.type === 'uno') res = E.callUno(m, player.id, now);
    else if (move.type === 'play') res = E.playCard(m, player.id, move.cardId, move.color, now);
    else if (move.type === 'draw') res = E.drawAction(m, player.id, now);
    else res = E.passAction(m, player.id, now);
    if (res.ok) {
      this.afterEngine(room, res, now);
      // arming UNO doesn't end the turn: let the bot move again quickly
      if (move.type === 'uno') room.botDue = { pid: player.id, at: now + this.rand(350, 700) };
    } else {
      // The engine rejected the autopilot move (should not happen); fall back to the timeout path.
      const t = E.timeoutTurn(m, player.id, now);
      if (t.ok) this.afterEngine(room, t, now);
    }
  }

  beginMatch(room, now) {
    const ids = this.active(room).sort((a, b) => a.joinedAt - b.joinedAt).map((p) => p.id);
    if (ids.length < 2) {
      room.status = 'WAITING';
      room.countdownEndsAt = 0;
      this.emit(room, [{ type: 'start_cancelled' }]);
      return;
    }
    for (const p of this.active(room)) { p.timeouts = 0; p.afk = false; }
    room.match = E.createMatch({ playerIds: ids, settings: room.settings, rng: this.rng, now });
    room.status = 'PLAYING';
    room.botDue = null;
    room.catchDue.clear();
    const events = E.startRound(room.match, now);
    this.emit(room, events);
  }
}

// Events worth showing in the on-screen log after a reload.
const LOGGED = new Set(['play', 'draw', 'skip', 'reverse', 'color', 'pending', 'uno', 'caught', 'timeout',
  'player_joined', 'player_left', 'player_disconnected', 'player_reconnected', 'host_changed', 'afk', 'round_end', 'reshuffle']);

// ---------------------------------------------------------------- action handlers (this = RoomManager)

const ACTIONS = {
  settings(room, player, args) {
    if (!this.isHost(room, player)) return fail('FORBIDDEN');
    if (room.status !== 'WAITING') return fail('WRONG_STATE');
    const res = E.sanitizeSettings(args.settings, room.settings);
    if (!res.ok) return fail(res.error);
    if (res.settings.maxPlayers < this.active(room).length) return fail('TOO_MANY_PLAYERS');
    room.settings = res.settings;
    this.emit(room, [{ type: 'settings', settings: room.settings }]);
    return { ok: true };
  },

  add_bot(room, player) {
    if (!this.isHost(room, player)) return fail('FORBIDDEN');
    if (room.status !== 'WAITING') return fail('WRONG_STATE');
    if (this.active(room).length >= room.settings.maxPlayers) return fail('ROOM_FULL');
    const names = ['Bolt', 'Nova', 'Pixel', 'Echo', 'Rex', 'Ziggy', 'Luna', 'Turbo'];
    const taken = new Set(this.active(room).map((p) => p.name.toLowerCase()));
    const base = names.find((n) => !taken.has((n + ' (Bot)').toLowerCase())) || 'Bot';
    const bot = this.makePlayer(room, { name: base + ' (Bot)', isBot: true });
    this.emit(room, [{ type: 'player_joined', pid: bot.id, name: bot.name, bot: true }]);
    return { ok: true };
  },

  remove_bot(room, player, args) {
    if (!this.isHost(room, player)) return fail('FORBIDDEN');
    if (room.status !== 'WAITING') return fail('WRONG_STATE');
    const bot = room.players.get(args.target);
    if (!bot || !bot.isBot || bot.left) return fail('BOT_NOT_FOUND');
    room.players.delete(bot.id);
    this.emit(room, [{ type: 'player_left', pid: bot.id, name: bot.name, reason: 'removed' }]);
    return { ok: true };
  },

  kick(room, player, args, now) {
    if (!this.isHost(room, player)) return fail('FORBIDDEN');
    if (room.status !== 'WAITING') return fail('WRONG_STATE');
    const target = room.players.get(args.target);
    if (!target || target.left || target.id === player.id) return fail('BAD_REQUEST');
    if (target.isBot) return ACTIONS.remove_bot.call(this, room, player, args, now);
    for (const c of target.conns) { try { c.send({ type: 'kicked' }); } catch (_) { /* ignore */ } }
    this.removeFromRoom(room, target, 'kicked', now);
    return { ok: true };
  },

  start(room, player, args, now) {
    if (!this.isHost(room, player)) return fail('FORBIDDEN');
    if (room.status !== 'WAITING') return fail('WRONG_STATE');
    if (this.active(room).length < 2) return fail('NOT_ENOUGH_PLAYERS');
    room.status = 'STARTING';
    room.countdownEndsAt = now + this.cfg.countdownMs;
    this.emit(room, [{ type: 'countdown', endsAt: room.countdownEndsAt }]);
    return { ok: true };
  },

  // A reaction is chatter, not play: it never counts as activity for the AFK check and is never stored in the log.
  emote(room, player, args, now) {
    if (room.status === 'CLOSED') return fail('WRONG_STATE');
    if (typeof args.id !== 'string' || !EMOTES.includes(args.id)) return fail('BAD_REQUEST');
    const recent = (player.emoteAt || []).filter((t) => now - t < EMOTE_WINDOW_MS);
    if (recent.length >= EMOTE_BURST || (recent.length && now - recent[recent.length - 1] < EMOTE_GAP_MS)) return fail('RATE_LIMITED');
    recent.push(now);
    player.emoteAt = recent;
    this.emit(room, [{ type: 'emote', pid: player.id, id: args.id }]);
    if (this.rng() < 0.4) this.queueBotEmote(room, EMOTE_REPLY[args.id] || 'nice', 900, 2200);
    return { ok: true };
  },

  leave(room, player, args, now) {
    this.removeFromRoom(room, player, 'left', now);
    return { ok: true };
  },

  play(room, player, args, now) {
    if (room.status !== 'PLAYING' || !room.match) return fail('NOT_PLAYING');
    const id = Number(args.cardId);
    if (!Number.isInteger(id)) return fail('BAD_REQUEST');
    const res = E.playCard(room.match, player.id, id, args.color, now);
    if (res.ok) this.touchHuman(player);
    return this.afterEngine(room, res, now);
  },

  draw(room, player, args, now) {
    if (room.status !== 'PLAYING' || !room.match) return fail('NOT_PLAYING');
    const res = E.drawAction(room.match, player.id, now);
    if (res.ok) this.touchHuman(player);
    return this.afterEngine(room, res, now);
  },

  pass(room, player, args, now) {
    if (room.status !== 'PLAYING' || !room.match) return fail('NOT_PLAYING');
    const res = E.passAction(room.match, player.id, now);
    if (res.ok) this.touchHuman(player);
    return this.afterEngine(room, res, now);
  },

  uno(room, player, args, now) {
    if (room.status !== 'PLAYING' || !room.match) return fail('NOT_PLAYING');
    const res = E.callUno(room.match, player.id, now);
    if (res.ok) this.touchHuman(player);
    return this.afterEngine(room, res, now);
  },

  catch(room, player, args, now) {
    if (room.status !== 'PLAYING' || !room.match) return fail('NOT_PLAYING');
    const res = E.catchUno(room.match, player.id, String(args.target), now);
    return this.afterEngine(room, res, now);
  },

  rematch(room, player, args, now) {
    if (!this.isHost(room, player)) return fail('FORBIDDEN');
    if (room.status !== 'COMPLETED') return fail('WRONG_STATE');
    this.purge(room);
    if (this.active(room).length < 2) return fail('NOT_ENOUGH_PLAYERS');
    room.match = null;
    room.status = 'STARTING';
    room.countdownEndsAt = now + this.cfg.countdownMs;
    this.emit(room, [{ type: 'countdown', endsAt: room.countdownEndsAt, rematch: true }]);
    return { ok: true };
  },

  to_lobby(room, player, args, now) {
    if (!this.isHost(room, player)) return fail('FORBIDDEN');
    if (room.status !== 'COMPLETED') return fail('WRONG_STATE');
    this.purge(room);
    room.match = null;
    room.status = 'WAITING';
    this.emit(room, [{ type: 'lobby' }]);
    return { ok: true };
  },
};

/** Drop players that are gone (left, or offline at the end of a match). */
RoomManager.prototype.purge = function purge(room) {
  for (const p of [...room.players.values()]) {
    if (p.left || (!p.isBot && !p.connected)) room.players.delete(p.id);
  }
  if (!room.players.has(room.hostId)) {
    const humans = this.humans(room);
    if (humans.length) room.hostId = humans[0].id;
  }
};

module.exports = { RoomManager, MESSAGES, CODE_ALPHABET, CODE_LENGTH, AVATARS, EMOTES, configFromEnv, normalizeCode, cleanName };
