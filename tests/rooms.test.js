'use strict';
// Room-level behaviour that is not game rules: reactions (emotes), chat and their limits.
const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager, EMOTES, CHAT_MAX_CHARS, CHAT_HISTORY, FRAMES, cleanChat } = require('../server/rooms');

function seeded(seed = 7) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function setup({ rng = seeded() } = {}) {
  const clock = { t: 1_000_000 };
  const mgr = new RoomManager({ rng, now: () => clock.t });
  const host = mgr.createRoom({ name: 'Host', avatar: 'fox' });
  const guest = mgr.joinRoom({ code: host.code, name: 'Guest', avatar: 'cat' });
  const inbox = { host: [], guest: [] };
  mgr.subscribe({ code: host.code, pid: host.pid, token: host.token }, { send: (m) => inbox.host.push(m) });
  mgr.subscribe({ code: guest.code, pid: guest.pid, token: guest.token }, { send: (m) => inbox.guest.push(m) });
  const act = (who, type, extra = {}) => mgr.action({ code: host.code, pid: who.pid, token: who.token, type, ...extra });
  const emotesIn = (box) => box.flatMap((m) => (m.events || []).filter((e) => e.type === 'emote'));
  return { mgr, clock, host, guest, inbox, act, emotesIn };
}

test('an emote reaches everyone in the room, named by the sender', () => {
  const { act, host, guest, inbox, emotesIn } = setup();
  assert.deepEqual(act(host, 'emote', { id: 'gg' }), { ok: true });
  const seenByGuest = emotesIn(inbox.guest);
  assert.equal(seenByGuest.length, 1);
  assert.equal(seenByGuest[0].pid, host.pid);
  assert.equal(seenByGuest[0].id, 'gg');
  assert.equal(emotesIn(inbox.host).length, 1, 'the sender sees their own reaction too');
  assert.notEqual(guest.pid, host.pid);
});

test('only allowlisted reactions are accepted; nothing the player types is relayed', () => {
  const { act, clock, host, inbox, emotesIn } = setup();
  for (const bad of ['<script>alert(1)</script>', 'hello everyone', '', 'GG', 42, null, undefined, { id: 'gg' }, ['gg']]) {
    const res = act(host, 'emote', { id: bad });
    assert.equal(res.ok, false, `rejects ${JSON.stringify(bad)}`);
    assert.equal(res.error, 'BAD_REQUEST');
  }
  assert.equal(emotesIn(inbox.guest).length, 0);
  for (const id of EMOTES) { clock.t += 7000; assert.equal(act(host, 'emote', { id }).ok, true, `accepts ${id}`); }
});

test('reactions are rate limited: spacing and a burst cap, per player', () => {
  const { act, clock, host, guest } = setup({ rng: () => 0.99 }); // 0.99 keeps bots from replying
  assert.equal(act(host, 'emote', { id: 'nice' }).ok, true);
  const tooSoon = act(host, 'emote', { id: 'nice' });
  assert.equal(tooSoon.ok, false);
  assert.equal(tooSoon.error, 'RATE_LIMITED');
  assert.equal(tooSoon.message, 'SLOW DOWN A LITTLE.');
  assert.equal(act(guest, 'emote', { id: 'nice' }).ok, true, 'another player is not affected');
  clock.t += 800; assert.equal(act(host, 'emote', { id: 'wow' }).ok, true);
  clock.t += 800; assert.equal(act(host, 'emote', { id: 'fire' }).ok, true);
  clock.t += 800; assert.equal(act(host, 'emote', { id: 'haha' }).error, 'RATE_LIMITED', 'fourth inside six seconds');
  clock.t += 6000; assert.equal(act(host, 'emote', { id: 'haha' }).ok, true, 'the window slides');
});

test('a reaction needs a valid session', () => {
  const { mgr, host } = setup();
  const res = mgr.action({ code: host.code, pid: host.pid, token: 'wrong', type: 'emote', id: 'gg' });
  assert.equal(res.ok, false);
});

test('reactions do not count as activity for the autopilot check', () => {
  const { mgr, act, host } = setup();
  const room = mgr.rooms.get(host.code);
  const p = room.players.get(host.pid);
  p.timeouts = 1; p.afk = true;
  act(host, 'emote', { id: 'gg' });
  assert.equal(p.afk, true);
  assert.equal(p.timeouts, 1);
});

test('bots sometimes answer a reaction, after a delay, and only while they are in the room', () => {
  const { mgr, act, clock, host, inbox, emotesIn } = setup({ rng: () => 0.1 }); // 0.1 < 0.4, so the bot always replies
  act(host, 'add_bot');
  assert.equal(act(host, 'emote', { id: 'gg' }).ok, true);
  const before = emotesIn(inbox.host).length;
  mgr.tick(clock.t + 100);
  assert.equal(emotesIn(inbox.host).length, before, 'nothing instantly');
  clock.t += 5000;
  mgr.tick(clock.t);
  const all = emotesIn(inbox.host);
  assert.equal(all.length, before + 1);
  const reply = all[all.length - 1];
  const room = mgr.rooms.get(host.code);
  assert.equal(room.players.get(reply.pid).isBot, true);
  assert.equal(reply.id, 'gg');
});

test('a bot that has been removed never speaks', () => {
  const { mgr, act, clock, host, inbox, emotesIn } = setup({ rng: () => 0.1 });
  act(host, 'add_bot');
  const room = mgr.rooms.get(host.code);
  const bot = [...room.players.values()].find((p) => p.isBot);
  act(host, 'emote', { id: 'nice' });
  act(host, 'remove_bot', { target: bot.id });
  const before = emotesIn(inbox.host).length;
  clock.t += 5000; mgr.tick(clock.t);
  assert.equal(emotesIn(inbox.host).length, before);
});

// ---------------------------------------------------------------------------------------------- chat

const chatsIn = (box) => box.flatMap((m) => (m.events || []).filter((e) => e.type === 'chat')).map((e) => e.msg);

test('a chat message reaches everyone in the room, attributed to the sender by the server', () => {
  const { act, host, guest, inbox } = setup();
  assert.deepEqual(act(guest, 'chat', { text: 'good luck everyone' }), { ok: true });
  for (const box of [inbox.host, inbox.guest]) {
    const got = chatsIn(box);
    assert.equal(got.length, 1);
    assert.equal(got[0].text, 'good luck everyone');
    assert.equal(got[0].pid, guest.pid);
    assert.equal(got[0].name, 'Guest');
    assert.equal(typeof got[0].at, 'number');
  }
  assert.notEqual(host.pid, guest.pid);
});

test('a sender cannot choose who a message is from, and ids only ever go up', () => {
  const { act, clock, host, guest, inbox } = setup();
  act(host, 'chat', { text: 'one', name: 'Guest', from: guest.pid, sender: guest.pid, id: 999, at: 1 });
  clock.t += 1000;
  act(host, 'chat', { text: 'two' });
  const got = chatsIn(inbox.guest);
  assert.deepEqual(got.map((m) => m.pid), [host.pid, host.pid]);
  assert.deepEqual(got.map((m) => m.name), ['Host', 'Host']);
  assert.deepEqual(got.map((m) => m.id), [1, 2]);
});

test('chat text is cleaned: control and invisible characters go, spaces collapse, markup stays as plain text', () => {
  assert.equal(cleanChat('  hello \n\t  world  '), 'hello world');
  assert.equal(cleanChat('a\u202Eb'), 'a b', 'bidi override is dropped');
  assert.equal(cleanChat('a\u200Bb\u0000c'), 'a b c', 'zero-width and NUL are dropped');
  assert.equal(cleanChat('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>', 'kept verbatim; the client renders with textContent');
  assert.equal(cleanChat('I <3 this'), 'I <3 this');
  assert.equal(cleanChat('x\u0301\u0302\u0303\u0304\u0305y'), 'x\u0301\u0302y', 'stacked combining marks are cut to two');
  assert.equal(cleanChat('   \u200B\n  '), null);
  assert.equal(cleanChat(''), null);
  assert.equal(cleanChat(42), null);
});

test('bad chat input is refused and nothing is relayed', () => {
  const { act, host, inbox } = setup();
  for (const bad of [undefined, null, 42, {}, [], '', '   ', '\u200B\u200B']) {
    const res = act(host, 'chat', { text: bad });
    assert.equal(res.ok, false, `rejects ${JSON.stringify(bad)}`);
    assert.equal(res.error, 'BAD_REQUEST');
  }
  const tooLong = act(host, 'chat', { text: 'x'.repeat(CHAT_MAX_CHARS + 1) });
  assert.equal(tooLong.error, 'CHAT_TOO_LONG');
  assert.equal(tooLong.message, 'THAT MESSAGE IS TOO LONG (200 CHARACTERS AT MOST).');
  assert.equal(act(host, 'chat', { text: 'y'.repeat(CHAT_MAX_CHARS * 10 + 1) }).error, 'CHAT_TOO_LONG', 'huge payloads are refused before any work');
  assert.equal(chatsIn(inbox.guest).length, 0);
  assert.equal(act(host, 'chat', { text: 'z'.repeat(CHAT_MAX_CHARS) }).ok, true, 'exactly the limit is fine');
});

test('the length limit counts characters, not bytes: emoji and accents are not penalised', () => {
  const { act, host } = setup();
  assert.equal(act(host, 'chat', { text: '🔥'.repeat(CHAT_MAX_CHARS) }).ok, true);
});

test('chat is rate limited per player: spacing and a burst cap', () => {
  const { act, clock, host, guest } = setup();
  assert.equal(act(host, 'chat', { text: 'a' }).ok, true);
  const tooSoon = act(host, 'chat', { text: 'b' });
  assert.equal(tooSoon.ok, false);
  assert.equal(tooSoon.error, 'RATE_LIMITED');
  assert.equal(tooSoon.message, 'SLOW DOWN A LITTLE.');
  assert.equal(act(guest, 'chat', { text: 'c' }).ok, true, 'another player is not affected');
  for (let i = 0; i < 4; i += 1) { clock.t += 600; assert.equal(act(host, 'chat', { text: 'm' + i }).ok, true, `message ${i + 2}`); }
  clock.t += 600;
  assert.equal(act(host, 'chat', { text: 'sixth inside ten seconds' }).error, 'RATE_LIMITED');
  clock.t += 10000;
  assert.equal(act(host, 'chat', { text: 'the window slides' }).ok, true);
});

test('late joiners and reconnecting players receive the recent history, capped, in order', () => {
  const { mgr, act, clock, host, guest } = setup();
  for (let i = 1; i <= CHAT_HISTORY + 15; i += 1) { clock.t += 1000; assert.equal(act(i % 2 ? host : guest, 'chat', { text: 'm' + i }).ok, true); }
  const late = mgr.joinRoom({ code: host.code, name: 'Late', avatar: 'panda' });
  let sync = null;
  mgr.subscribe({ code: host.code, pid: late.pid, token: late.token }, { send: (m) => { if (m.type === 'sync') sync = m; } });
  assert.ok(sync, 'a sync message arrives on connect');
  assert.equal(sync.chat.length, CHAT_HISTORY);
  assert.equal(sync.chat[0].text, 'm16');
  assert.equal(sync.chat[sync.chat.length - 1].text, 'm75');
  assert.deepEqual(sync.chat.map((m) => m.id), [...sync.chat.map((m) => m.id)].sort((a, b) => a - b));
  assert.equal(sync.state.chatOn, true);
});

test('only the host can turn chat off; while it is off nobody can post, and turning it on again restores it', () => {
  const { act, host, guest, inbox } = setup();
  const denied = act(guest, 'chat_mode', { on: false });
  assert.equal(denied.error, 'FORBIDDEN');
  assert.equal(act(host, 'chat_mode', { on: 'no' }).error, 'BAD_REQUEST');
  assert.equal(act(host, 'chat_mode', { on: false }).ok, true);
  const seen = inbox.guest.flatMap((m) => (m.events || []).filter((e) => e.type === 'chat_mode'));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].on, false);
  assert.equal(seen[0].name, 'Host');
  assert.equal(inbox.guest[inbox.guest.length - 1].state.chatOn, false);
  const blocked = act(guest, 'chat', { text: 'hello?' });
  assert.equal(blocked.error, 'CHAT_OFF');
  assert.equal(blocked.message, 'CHAT IS TURNED OFF IN THIS ROOM.');
  assert.equal(act(host, 'chat', { text: 'not even the host' }).error, 'CHAT_OFF');
  assert.equal(act(host, 'chat_mode', { on: false }).ok, true, 'switching to the same state is harmless');
  assert.equal(act(host, 'chat_mode', { on: true }).ok, true);
  assert.equal(act(guest, 'chat', { text: 'back on' }).ok, true);
});

test('chatting does not count as activity for the autopilot check', () => {
  const { mgr, act, host } = setup();
  const p = mgr.rooms.get(host.code).players.get(host.pid);
  p.timeouts = 1; p.afk = true;
  act(host, 'chat', { text: 'still here, honest' });
  assert.equal(p.afk, true);
  assert.equal(p.timeouts, 1);
});

test('a player who has left can no longer chat, and a wrong token is refused', () => {
  const { mgr, act, host, guest } = setup();
  assert.equal(mgr.action({ code: host.code, pid: guest.pid, token: 'nope', type: 'chat', text: 'hi' }).ok, false);
  act(guest, 'leave');
  assert.equal(act(guest, 'chat', { text: 'ghost' }).ok, false);
});

test('chat keeps working through a match and after it', () => {
  const { act, clock, host, guest, inbox } = setup();
  assert.equal(act(host, 'start').ok, true);
  clock.t += 5000;
  assert.equal(act(guest, 'chat', { text: 'during the countdown' }).ok, true);
  assert.equal(chatsIn(inbox.host).length, 1);
});

// ---------------------------------------------------------------- avatar frames
test('avatar frames: only allowlisted frames are kept, everything else falls back to steel', () => {
  const mgr = new RoomManager({ rng: seeded(), now: () => 1_000_000 });
  const host = mgr.createRoom({ name: 'Host', avatar: 'fox', frame: 'prism' });
  const bad = mgr.joinRoom({ code: host.code, name: 'Bad', avatar: 'cat', frame: '<script>alert(1)</script>' });
  const none = mgr.joinRoom({ code: host.code, name: 'None', avatar: 'cat' });
  const view = (r) => { let got; mgr.subscribe({ code: host.code, pid: r.pid, token: r.token }, { send: (m) => { if (m.type === 'sync') got = m; } }); return got; };
  const players = view(host).state.players;
  const byName = Object.fromEntries(players.map((p) => [p.name, p.frame]));
  assert.equal(byName.Host, 'prism');
  assert.equal(byName.Bad, 'steel');
  assert.equal(byName.None, 'steel');
  assert.ok(FRAMES.includes('gilded') && FRAMES.includes('neon') && FRAMES.length === 4);
});

test('avatar frames are visible to the other players and bots always wear steel', () => {
  const mgr = new RoomManager({ rng: seeded(), now: () => 1_000_000 });
  const host = mgr.createRoom({ name: 'Host', avatar: 'fox', frame: 'gilded' });
  const guest = mgr.joinRoom({ code: host.code, name: 'Guest', avatar: 'cat', frame: 'neon' });
  assert.deepEqual(mgr.action({ code: host.code, pid: host.pid, token: host.token, type: 'add_bot' }), { ok: true });
  let sync;
  mgr.subscribe({ code: host.code, pid: guest.pid, token: guest.token }, { send: (m) => { if (m.type === 'sync') sync = m; } });
  const seen = sync.state.players;
  assert.equal(seen.find((p) => p.name === 'Host').frame, 'gilded');
  assert.equal(seen.find((p) => p.name === 'Guest').frame, 'neon');
  assert.equal(seen.find((p) => p.isBot).frame, 'steel');
});
