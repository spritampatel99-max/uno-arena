'use strict';
// Room-level behaviour that is not game rules: reactions (emotes) and their limits.
const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager, EMOTES } = require('../server/rooms');

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
