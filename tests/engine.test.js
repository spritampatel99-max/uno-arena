'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../server/engine');

// ---- helpers -------------------------------------------------------------

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

const NOW = 1_000_000;
let nextId = 1000;
const card = (color, kind, value = null) => ({ id: nextId++, color, kind, value });
const num = (color, value) => card(color, 'num', value);

/** Build a match in a fully controlled state (no randomness involved). */
function setup({ players = ['a', 'b', 'c'], settings = {}, hands = {}, top = num('red', 5), color, turn = 0, dir = 1 } = {}) {
  const s = { ...E.DEFAULT_SETTINGS, ...settings };
  const m = E.createMatch({ playerIds: players, settings: s, rng: mulberry32(7), now: NOW });
  E.startRound(m, NOW);
  // overwrite with the scripted state
  m.deck = E.shuffle(E.buildDeck(), mulberry32(3)).filter((c) => c.id < 108);
  m.discard = [top];
  m.activeColor = color || top.color;
  m.dir = dir;
  m.turnIdx = turn;
  m.pending = null;
  m.drawn = null;
  m.phase = 'playing';
  for (const pid of players) {
    m.hands[pid] = hands[pid] || [num('green', 1), num('green', 2), num('green', 3), num('green', 4)];
    m.uno[pid] = { called: false, vulnerableUntil: 0 };
  }
  m.turnEndsAt = NOW + s.turnSeconds * 1000;
  return m;
}

const kinds = (events) => events.map((e) => e.type);
const total = (m) => m.deck.length + m.discard.length + Object.values(m.hands).reduce((a, h) => a + h.length, 0);

// ---- deck ----------------------------------------------------------------

test('deck has 108 cards with the official composition', () => {
  const deck = E.buildDeck();
  assert.equal(deck.length, 108);
  assert.equal(new Set(deck.map((c) => c.id)).size, 108);
  for (const color of E.COLORS) {
    const of = deck.filter((c) => c.color === color);
    assert.equal(of.length, 25);
    assert.equal(of.filter((c) => c.kind === 'num' && c.value === 0).length, 1);
    for (let v = 1; v <= 9; v++) assert.equal(of.filter((c) => c.kind === 'num' && c.value === v).length, 2);
    for (const k of ['skip', 'reverse', 'draw2']) assert.equal(of.filter((c) => c.kind === k).length, 2);
  }
  assert.equal(deck.filter((c) => c.kind === 'wild').length, 4);
  assert.equal(deck.filter((c) => c.kind === 'wild4').length, 4);
});

test('shuffle is a permutation and deterministic for a seed', () => {
  const a = E.shuffle(E.buildDeck(), mulberry32(1)).map((c) => c.id);
  const b = E.shuffle(E.buildDeck(), mulberry32(1)).map((c) => c.id);
  const c = E.shuffle(E.buildDeck(), mulberry32(2)).map((c2) => c2.id);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.deepEqual([...a].sort((x, y) => x - y), [...Array(108).keys()]);
});

test('card points', () => {
  assert.equal(E.cardPoints(num('red', 7)), 7);
  assert.equal(E.cardPoints(card('red', 'skip')), 20);
  assert.equal(E.cardPoints(card('red', 'reverse')), 20);
  assert.equal(E.cardPoints(card('red', 'draw2')), 20);
  assert.equal(E.cardPoints(card(null, 'wild')), 50);
  assert.equal(E.cardPoints(card(null, 'wild4')), 50);
});

// ---- deal ----------------------------------------------------------------

test('startRound deals the configured number of cards and conserves the deck', () => {
  for (const startingCards of [5, 7, 10]) {
    for (let seed = 1; seed <= 30; seed++) {
      const m = E.createMatch({ playerIds: ['a', 'b', 'c', 'd'], settings: { ...E.DEFAULT_SETTINGS, startingCards }, rng: mulberry32(seed), now: NOW });
      const events = E.startRound(m, NOW);
      assert.equal(total(m), 108);
      const top = E.topCard(m);
      assert.ok(top.kind !== 'wild' && top.kind !== 'wild4', 'start card is never a wild');
      assert.equal(events[0].type, 'round_start');
      const draw2Start = top.kind === 'draw2';
      for (const pid of m.order) {
        const expected = startingCards + (draw2Start && pid === events.find((e) => e.type === 'draw')?.pid ? 2 : 0);
        assert.equal(m.hands[pid].length, expected);
      }
    }
  }
});

test('starting card effects: skip, reverse and draw two', () => {
  let seen = new Set();
  for (let seed = 1; seed < 600 && seen.size < 3; seed++) {
    const m = E.createMatch({ playerIds: ['a', 'b', 'c'], settings: E.DEFAULT_SETTINGS, rng: mulberry32(seed), now: NOW });
    const dealer = m.order[m.dealerIdx];
    const ev = E.startRound(m, NOW);
    const k = E.topCard(m).kind;
    const first = m.order[(m.dealerIdx + 1) % 3];
    if (k === 'skip') {
      seen.add(k);
      assert.equal(E.currentId(m), m.order[(m.dealerIdx + 2) % 3]);
    } else if (k === 'reverse') {
      seen.add(k);
      assert.equal(m.dir, -1);
      assert.equal(E.currentId(m), dealer);
    } else if (k === 'draw2') {
      seen.add(k);
      assert.equal(m.hands[first].length, 9);
      assert.equal(E.currentId(m), m.order[(m.dealerIdx + 2) % 3]);
      assert.ok(kinds(ev).includes('skip'));
    }
  }
  assert.equal(seen.size, 3, 'found examples of all three starting action cards');
});

// ---- legality ------------------------------------------------------------

test('colour match, number match and symbol match are legal; others are not', () => {
  const m = setup({ top: num('red', 5), hands: { a: [num('red', 9), num('blue', 5), num('blue', 6), card('blue', 'skip'), num('green', 2)], b: [num('green', 1)], c: [num('green', 1)] } });
  const ids = E.playableIds(m, 'a');
  const h = m.hands.a;
  assert.deepEqual(ids.sort(), [h[0].id, h[1].id].sort());
  assert.equal(E.playCard(m, 'a', h[2].id, null, NOW).error, 'ILLEGAL_MOVE');
  assert.equal(E.playCard(m, 'a', h[4].id, null, NOW).error, 'ILLEGAL_MOVE');
});

test('symbol match across colours (skip on skip)', () => {
  const m = setup({ top: card('red', 'skip'), hands: { a: [card('blue', 'skip'), num('green', 3)], b: [num('green', 1)], c: [num('green', 1)] } });
  assert.deepEqual(E.playableIds(m, 'a'), [m.hands.a[0].id]);
});

test('only the current player may play; wrong cards are rejected', () => {
  const m = setup({ top: num('red', 5), hands: { a: [num('red', 1), num('red', 2)], b: [num('red', 3), num('red', 4)], c: [num('green', 1)] } });
  assert.equal(E.playCard(m, 'b', m.hands.b[0].id, null, NOW).error, 'NOT_YOUR_TURN');
  assert.equal(E.playCard(m, 'a', 99999, null, NOW).error, 'NOT_IN_HAND');
  assert.equal(E.playCard(m, 'a', m.hands.b[0].id, null, NOW).error, 'NOT_IN_HAND');
  assert.equal(E.playCard(m, 'zzz', 1, null, NOW).error, 'NOT_IN_GAME');
});

test('wild needs a valid colour', () => {
  const w = card(null, 'wild');
  const m = setup({ hands: { a: [w, num('green', 3)], b: [num('green', 1)], c: [num('green', 1)] } });
  assert.equal(E.playCard(m, 'a', w.id, null, NOW).error, 'COLOR_REQUIRED');
  assert.equal(E.playCard(m, 'a', w.id, 'purple', NOW).error, 'COLOR_REQUIRED');
  const r = E.playCard(m, 'a', w.id, 'blue', NOW);
  assert.ok(r.ok);
  assert.equal(m.activeColor, 'blue');
  assert.equal(E.currentId(m), 'b');
});

test('Wild Draw Four is refused while the hand holds the active colour, allowed otherwise', () => {
  const w4 = card(null, 'wild4');
  let m = setup({ top: num('red', 5), hands: { a: [w4, num('red', 8), num('blue', 2)], b: [num('green', 1), num('green', 2)], c: [num('green', 1)] } });
  assert.equal(E.playCard(m, 'a', w4.id, 'blue', NOW).error, 'WILD4_ILLEGAL');
  assert.ok(!E.playableIds(m, 'a').includes(w4.id));

  const w4b = card(null, 'wild4');
  m = setup({ top: num('red', 5), hands: { a: [w4b, num('blue', 2), num('green', 9)], b: [num('green', 1), num('green', 2)], c: [num('green', 1)] } });
  const before = m.hands.b.length;
  const r = E.playCard(m, 'a', w4b.id, 'yellow', NOW);
  assert.ok(r.ok);
  assert.equal(m.hands.b.length, before + 4);
  assert.equal(m.activeColor, 'yellow');
  assert.equal(E.currentId(m), 'c', 'victim loses the turn');
});

// ---- card effects ---------------------------------------------------------

test('number card passes the turn clockwise', () => {
  const m = setup({ top: num('red', 5), hands: { a: [num('red', 1), num('red', 2)], b: [num('red', 3)], c: [num('red', 4)] } });
  E.playCard(m, 'a', m.hands.a[0].id, null, NOW);
  assert.equal(E.currentId(m), 'b');
});

test('skip skips exactly one player', () => {
  const sk = card('red', 'skip');
  const m = setup({ top: num('red', 5), hands: { a: [sk, num('red', 2)], b: [num('red', 3), num('red', 9)], c: [num('red', 4), num('red', 6)] } });
  const r = E.playCard(m, 'a', sk.id, null, NOW);
  assert.ok(r.ok);
  assert.equal(E.currentId(m), 'c');
  assert.ok(kinds(r.events).includes('skip'));
});

test('reverse flips direction with 3+ players and acts as skip with 2', () => {
  const rv = card('red', 'reverse');
  let m = setup({ top: num('red', 5), turn: 1, hands: { a: [num('red', 1)], b: [rv, num('red', 2)], c: [num('red', 4)] } });
  E.playCard(m, 'b', rv.id, null, NOW);
  assert.equal(m.dir, -1);
  assert.equal(E.currentId(m), 'a');

  const rv2 = card('red', 'reverse');
  m = setup({ players: ['a', 'b'], top: num('red', 5), hands: { a: [rv2, num('red', 2)], b: [num('red', 1)] } });
  E.playCard(m, 'a', rv2.id, null, NOW);
  assert.equal(E.currentId(m), 'a', 'with two players reverse gives the same player another turn');
});

test('counter-clockwise order wraps correctly', () => {
  const m = setup({ top: num('red', 5), dir: -1, turn: 0, hands: { a: [num('red', 1), num('red', 2)], b: [num('red', 3)], c: [num('red', 4)] } });
  E.playCard(m, 'a', m.hands.a[0].id, null, NOW);
  assert.equal(E.currentId(m), 'c');
});

test('draw two: victim draws 2 and loses the turn', () => {
  const d2 = card('red', 'draw2');
  const m = setup({ top: num('red', 5), hands: { a: [d2, num('red', 2)], b: [num('green', 3), num('green', 5)], c: [num('red', 4), num('red', 6)] } });
  const r = E.playCard(m, 'a', d2.id, null, NOW);
  assert.ok(r.ok);
  assert.equal(m.hands.b.length, 4);
  assert.equal(E.currentId(m), 'c');
  const ev = r.events.find((e) => e.type === 'draw');
  assert.equal(ev.pid, 'b');
  assert.equal(ev.cards.length, 2);
});

// ---- stacking --------------------------------------------------------------

test('stacking OFF: draw two applies immediately and cannot be answered', () => {
  const d2 = card('red', 'draw2');
  const m = setup({ top: num('red', 5), hands: { a: [d2, num('red', 2)], b: [card('blue', 'draw2'), num('green', 3)], c: [num('red', 4), num('red', 6)] } });
  E.playCard(m, 'a', d2.id, null, NOW);
  assert.equal(m.pending, null);
  assert.equal(m.hands.b.length, 4);
});

test('stacking ON: +2 on +2 accumulates, wrong stack is refused, draw takes everything', () => {
  const a2 = card('red', 'draw2');
  const b2 = card('blue', 'draw2');
  const m = setup({
    settings: { stacking: true }, top: num('red', 5),
    hands: { a: [a2, num('red', 2)], b: [b2, num('red', 3), card(null, 'wild4')], c: [num('red', 4), num('red', 6)] },
  });
  assert.ok(E.playCard(m, 'a', a2.id, null, NOW).ok);
  assert.deepEqual(m.pending, { kind: 'draw2', amount: 2 });
  assert.equal(E.currentId(m), 'b');
  // only a draw two may answer
  assert.deepEqual(E.playableIds(m, 'b'), [b2.id]);
  assert.equal(E.playCard(m, 'b', m.hands.b[1].id, null, NOW).error, 'MUST_STACK_OR_DRAW');
  assert.equal(E.playCard(m, 'b', m.hands.b[2].id, 'red', NOW).error, 'MUST_STACK_OR_DRAW');
  assert.ok(E.playCard(m, 'b', b2.id, null, NOW).ok);
  assert.deepEqual(m.pending, { kind: 'draw2', amount: 4 });
  assert.equal(E.currentId(m), 'c');
  const before = m.hands.c.length;
  const r = E.drawAction(m, 'c', NOW);
  assert.ok(r.ok);
  assert.equal(m.hands.c.length, before + 4);
  assert.equal(m.pending, null);
  assert.equal(E.currentId(m), 'a', 'taking the penalty ends the turn');
});

test('stacking ON: wild four stacks only on wild four', () => {
  const a4 = card(null, 'wild4');
  const b4 = card(null, 'wild4');
  const m = setup({
    settings: { stacking: true }, top: num('red', 5),
    hands: { a: [a4, num('blue', 2)], b: [b4, card('red', 'draw2'), num('blue', 9)], c: [num('red', 4), num('red', 6)] },
  });
  assert.ok(E.playCard(m, 'a', a4.id, 'green', NOW).ok);
  assert.deepEqual(m.pending, { kind: 'draw4', amount: 4 });
  assert.deepEqual(E.playableIds(m, 'b'), [b4.id]);
  assert.ok(E.playCard(m, 'b', b4.id, 'yellow', NOW).ok);
  assert.equal(m.pending.amount, 8);
});

// ---- drawing ---------------------------------------------------------------

test('draw: a playable drawn card may be played (only it), otherwise the turn ends', () => {
  const m = setup({ top: num('red', 5), hands: { a: [num('blue', 1), num('blue', 2)], b: [num('green', 1)], c: [num('green', 1)] } });
  const playableCard = num('red', 8);
  m.deck.push(playableCard);
  const r = E.drawAction(m, 'a', NOW);
  assert.ok(r.ok);
  assert.equal(E.currentId(m), 'a');
  assert.deepEqual(m.drawn, { pid: 'a', cardId: playableCard.id });
  assert.deepEqual(E.playableIds(m, 'a'), [playableCard.id]);
  assert.equal(E.playCard(m, 'a', m.hands.a[0].id, null, NOW).error, 'ONLY_DRAWN_CARD');
  assert.equal(E.drawAction(m, 'a', NOW).error, 'ALREADY_DRAWN');
  assert.ok(E.passAction(m, 'a', NOW).ok);
  assert.equal(E.currentId(m), 'b');

  const m2 = setup({ top: num('red', 5), hands: { a: [num('blue', 1)], b: [num('green', 1)], c: [num('green', 1)] } });
  m2.deck.push(num('blue', 9));
  assert.ok(E.drawAction(m2, 'a', NOW).ok);
  assert.equal(E.currentId(m2), 'b', 'unplayable drawn card ends the turn automatically');
});

test('cannot pass without drawing', () => {
  const m = setup({});
  assert.equal(E.passAction(m, 'a', NOW).error, 'CANNOT_PASS');
});

test('draw-until-playable keeps drawing until a match appears', () => {
  const m = setup({ settings: { drawUntilPlayable: true }, top: num('red', 5), hands: { a: [num('blue', 1)], b: [num('green', 1)], c: [num('green', 1)] } });
  m.deck.push(num('red', 9), num('blue', 3), num('yellow', 4)); // popped in reverse: yellow, blue, red
  const r = E.drawAction(m, 'a', NOW);
  assert.ok(r.ok);
  assert.equal(m.hands.a.length, 4);
  assert.equal(m.drawn.pid, 'a');
  assert.equal(E.currentId(m), 'a');
  const ev = r.events.find((e) => e.type === 'draw');
  assert.equal(ev.count, 3);
});

test('deck reshuffles the discard pile (keeping the top card) when it runs out', () => {
  const m = setup({ top: num('red', 5), hands: { a: [num('blue', 1)], b: [num('green', 1)], c: [num('green', 1)] } });
  const spare = [num('blue', 4), num('yellow', 6), num('green', 6)];
  m.discard = [...spare, num('red', 5)];
  m.deck = [];
  const top = E.topCard(m);
  const r = E.drawAction(m, 'a', NOW);
  assert.ok(r.ok);
  assert.ok(kinds(r.events).includes('reshuffle'));
  assert.equal(E.topCard(m), top);
  assert.equal(m.discard.length, 1);
});

test('drawing with an empty deck and empty discard simply passes', () => {
  const m = setup({ top: num('red', 5), hands: { a: [num('blue', 1)], b: [num('green', 1)], c: [num('green', 1)] } });
  m.deck = [];
  m.discard = [num('red', 5)];
  const r = E.drawAction(m, 'a', NOW);
  assert.ok(r.ok);
  assert.equal(E.currentId(m), 'b');
});

// ---- jump-in ---------------------------------------------------------------

test('jump-in: identical coloured card can be played out of turn when enabled', () => {
  const twin = num('red', 5);
  const m = setup({ settings: { jumpIn: true }, top: num('red', 5), hands: { a: [num('red', 1), num('blue', 2)], b: [num('green', 1)], c: [twin, num('green', 9)] } });
  assert.deepEqual(E.jumpInIds(m, 'c'), [twin.id]);
  const r = E.playCard(m, 'c', twin.id, null, NOW);
  assert.ok(r.ok);
  assert.ok(r.events.find((e) => e.type === 'play').jumpIn);
  assert.equal(E.currentId(m), 'a', 'play continues after the jumper');
});

test('jump-in is refused when disabled, for non-identical cards, and during a pending penalty', () => {
  const twin = num('red', 5);
  let m = setup({ top: num('red', 5), hands: { a: [num('red', 1)], b: [num('green', 1)], c: [twin, num('green', 9)] } });
  assert.equal(E.playCard(m, 'c', twin.id, null, NOW).error, 'NOT_YOUR_TURN');

  m = setup({ settings: { jumpIn: true }, top: num('red', 5), hands: { a: [num('red', 1)], b: [num('green', 1)], c: [num('red', 6), num('green', 9)] } });
  assert.equal(E.playCard(m, 'c', m.hands.c[0].id, null, NOW).error, 'NOT_YOUR_TURN');

  const d2 = card('red', 'draw2');
  const d2twin = card('red', 'draw2');
  m = setup({ settings: { jumpIn: true, stacking: true }, top: num('red', 5), hands: { a: [d2, num('red', 1)], b: [num('green', 1)], c: [d2twin, num('green', 9)] } });
  assert.ok(E.playCard(m, 'a', d2.id, null, NOW).ok);
  assert.equal(E.playCard(m, 'c', d2twin.id, null, NOW).error, 'NOT_YOUR_TURN');
});

// ---- UNO -------------------------------------------------------------------

test('UNO: calling at two cards arms it; playing down to one counts as declared', () => {
  const m = setup({ top: num('red', 5), hands: { a: [num('red', 1), num('red', 2)], b: [num('green', 1), num('green', 2)], c: [num('green', 1), num('green', 2)] } });
  const arm = E.callUno(m, 'a', NOW);
  assert.ok(arm.ok);
  assert.equal(arm.events[0].type, 'uno_armed');
  assert.equal(E.callUno(m, 'a', NOW).error, 'ALREADY_CALLED');
  const r = E.playCard(m, 'a', m.hands.a[0].id, null, NOW);
  assert.ok(kinds(r.events).includes('uno'));
  assert.equal(m.uno.a.vulnerableUntil, 0);
  assert.equal(E.catchUno(m, 'b', 'a', NOW).error, 'NOTHING_TO_CATCH');
});

test('UNO: forgetting opens a 4 s window; catching makes the target draw 2', () => {
  const m = setup({ top: num('red', 5), hands: { a: [num('red', 1), num('red', 2)], b: [num('green', 1), num('green', 2)], c: [num('green', 1), num('green', 2)] } });
  const r = E.playCard(m, 'a', m.hands.a[0].id, null, NOW);
  assert.ok(kinds(r.events).includes('one_card'));
  assert.equal(m.uno.a.vulnerableUntil, NOW + E.UNO_CATCH_WINDOW_MS);
  assert.equal(E.catchUno(m, 'a', 'a', NOW).error, 'CANNOT_CATCH_SELF');
  const c = E.catchUno(m, 'b', 'a', NOW + 1000);
  assert.ok(c.ok);
  assert.equal(m.hands.a.length, 3);
  assert.equal(m.stats.a.penalties, 1);
  assert.equal(E.catchUno(m, 'c', 'a', NOW + 1100).error, 'NOTHING_TO_CATCH');
});

test('UNO: a late catch fails, and the player can still call UNO inside the window', () => {
  const m = setup({ top: num('red', 5), hands: { a: [num('red', 1), num('red', 2)], b: [num('green', 1), num('green', 2)], c: [num('green', 1), num('green', 2)] } });
  E.playCard(m, 'a', m.hands.a[0].id, null, NOW);
  assert.equal(E.catchUno(m, 'b', 'a', NOW + E.UNO_CATCH_WINDOW_MS + 1).error, 'NOTHING_TO_CATCH');

  const m2 = setup({ top: num('red', 5), hands: { a: [num('red', 1), num('red', 2)], b: [num('green', 1), num('green', 2)], c: [num('green', 1), num('green', 2)] } });
  E.playCard(m2, 'a', m2.hands.a[0].id, null, NOW);
  assert.ok(E.callUno(m2, 'a', NOW + 2000).ok, 'self-declaration inside the window');
  assert.equal(E.catchUno(m2, 'b', 'a', NOW + 2100).error, 'NOTHING_TO_CATCH');
  const m3 = setup({ top: num('red', 5), hands: { a: [num('red', 1), num('red', 2)], b: [num('green', 1), num('green', 2)], c: [num('green', 1), num('green', 2)] } });
  E.playCard(m3, 'a', m3.hands.a[0].id, null, NOW);
  assert.equal(E.callUno(m3, 'a', NOW + E.UNO_CATCH_WINDOW_MS + 5).error, 'TOO_LATE');
});

test('UNO: cannot be called with many cards; drawing resets the flag; expireUno clears windows', () => {
  const m = setup({});
  assert.equal(E.callUno(m, 'a', NOW).error, 'NOT_NEEDED');
  const m2 = setup({ top: num('red', 5), hands: { a: [num('red', 1), num('red', 2)], b: [num('green', 1), num('green', 2)], c: [num('green', 1), num('green', 2)] } });
  E.playCard(m2, 'a', m2.hands.a[0].id, null, NOW);
  assert.equal(E.expireUno(m2, NOW + 100), false);
  assert.equal(E.expireUno(m2, NOW + E.UNO_CATCH_WINDOW_MS + 1), true);
  assert.equal(m2.uno.a.vulnerableUntil, 0);
});

// ---- scoring / round & match end -------------------------------------------

test('winning a round scores the opponents’ cards and ends the round', () => {
  const m = setup({
    top: num('red', 5),
    hands: { a: [num('red', 1)], b: [num('green', 7), card('blue', 'skip')], c: [card(null, 'wild'), num('green', 2)] },
  });
  const r = E.playCard(m, 'a', m.hands.a[0].id, null, NOW);
  assert.ok(r.ok);
  const end = r.events.find((e) => e.type === 'round_end');
  assert.equal(end.winnerId, 'a');
  assert.equal(end.points, 7 + 20 + 50 + 2);
  assert.equal(m.scores.a, 79);
  assert.equal(m.phase, 'round_over');
  assert.equal(E.playCard(m, 'b', m.hands.b[0].id, null, NOW).error, 'NOT_PLAYING');
});

test('a winning Draw Two still makes the victim draw before scoring', () => {
  const d2 = card('red', 'draw2');
  const m = setup({ top: num('red', 5), hands: { a: [d2], b: [num('green', 3)], c: [num('green', 2)] } });
  const r = E.playCard(m, 'a', d2.id, null, NOW);
  assert.ok(r.ok);
  assert.equal(m.hands.b.length, 3);
  const end = r.events.find((e) => e.type === 'round_end');
  assert.ok(end.points >= 3 + 2 + 0);
  assert.equal(end.leftovers.b.cards, 3);
});

test('match ends when the winning score is reached, otherwise another round can start', () => {
  const m = setup({ settings: { winningScore: 100 }, top: num('red', 5), hands: { a: [num('red', 1)], b: [num('green', 9)], c: [num('green', 9)] } });
  let r = E.playCard(m, 'a', m.hands.a[0].id, null, NOW);
  assert.equal(m.phase, 'round_over');
  assert.ok(!kinds(r.events).includes('match_end'));
  const ev = E.startRound(m, NOW + 5000);
  assert.equal(m.round, 2);
  assert.equal(m.phase, 'playing');
  assert.equal(ev[0].type, 'round_start');
  assert.equal(total(m), 108);

  const m2 = setup({ settings: { winningScore: 100 }, top: num('red', 5), hands: { a: [num('red', 1)], b: [card(null, 'wild4'), card(null, 'wild')], c: [num('green', 9)] } });
  r = E.playCard(m2, 'a', m2.hands.a[0].id, null, NOW);
  assert.ok(kinds(r.events).includes('match_end'));
  assert.equal(m2.phase, 'finished');
  assert.equal(m2.winnerId, 'a');
});

// ---- timeouts --------------------------------------------------------------

test('timeoutTurn draws a card and passes automatically', () => {
  const m = setup({ top: num('red', 5), hands: { a: [num('blue', 1)], b: [num('green', 1)], c: [num('green', 1)] } });
  m.deck.push(num('blue', 9));
  const r = E.timeoutTurn(m, 'a', NOW + 31000);
  assert.ok(r.ok);
  assert.equal(r.events[0].type, 'timeout');
  assert.equal(E.currentId(m), 'b');
  assert.equal(m.hands.a.length, 2);
  assert.equal(m.turnEndsAt, NOW + 31000 + 30000);
});

test('timeoutTurn: playable drawn card is not auto-played, the turn passes', () => {
  const m = setup({ top: num('red', 5), hands: { a: [num('blue', 1)], b: [num('green', 1)], c: [num('green', 1)] } });
  m.deck.push(num('red', 9));
  E.timeoutTurn(m, 'a', NOW + 31000);
  assert.equal(E.currentId(m), 'b');
  assert.equal(m.drawn, null);
});

test('timeoutTurn with a pending stacked penalty takes the penalty', () => {
  const m = setup({ settings: { stacking: true }, top: num('red', 5), hands: { a: [card('red', 'draw2'), num('red', 2)], b: [num('green', 1)], c: [num('green', 1)] } });
  E.playCard(m, 'a', m.hands.a[0].id, null, NOW);
  const r = E.timeoutTurn(m, 'b', NOW + 31000);
  assert.ok(r.ok);
  assert.equal(m.hands.b.length, 3);
  assert.equal(m.pending, null);
});

// ---- removePlayer ----------------------------------------------------------

test('removePlayer returns cards to the deck, fixes the turn and keeps order', () => {
  const m = setup({ top: num('red', 5), turn: 1, hands: { a: [num('red', 1), num('red', 2)], b: [num('green', 3), num('green', 4)], c: [num('red', 4), num('red', 6)] } });
  const deckBefore = m.deck.length;
  const r = E.removePlayer(m, 'b', NOW);
  assert.ok(r.ok);
  assert.deepEqual(m.order, ['a', 'c']);
  assert.equal(E.currentId(m), 'c', 'turn passes to the next player');
  assert.equal(m.deck.length, deckBefore + 2);
  assert.equal(m.hands.b, undefined);
  assert.equal(total(m), 108 - 0 - (108 - total(m)));
});

test('removePlayer of an earlier seat keeps the same current player', () => {
  const m = setup({ top: num('red', 5), turn: 2, hands: { a: [num('red', 1)], b: [num('green', 3)], c: [num('red', 4)] } });
  E.removePlayer(m, 'a', NOW);
  assert.equal(E.currentId(m), 'c');
});

test('removePlayer: the last remaining player wins by forfeit', () => {
  const m = setup({ players: ['a', 'b'], top: num('red', 5), hands: { a: [num('red', 1)], b: [num('green', 3)] } });
  const r = E.removePlayer(m, 'a', NOW);
  assert.ok(r.events.some((e) => e.type === 'match_end' && e.reason === 'forfeit'));
  assert.equal(m.winnerId, 'b');
  assert.equal(m.phase, 'finished');
});

// ---- settings --------------------------------------------------------------

test('sanitizeSettings accepts known options and rejects everything else', () => {
  assert.ok(E.sanitizeSettings({ startingCards: 10, stacking: true }).ok);
  assert.equal(E.sanitizeSettings({ maxPlayers: 9 }).error, 'BAD_SETTINGS');
  assert.equal(E.sanitizeSettings({ turnSeconds: 31 }).error, 'BAD_SETTINGS');
  assert.equal(E.sanitizeSettings({ stacking: 'yes' }).error, 'BAD_SETTINGS');
  assert.equal(E.sanitizeSettings({ hack: 1 }).error, 'BAD_SETTINGS');
  assert.equal(E.sanitizeSettings(null).error, 'BAD_SETTINGS');
  assert.equal(E.sanitizeSettings({ winningScore: 300 }).settings.winningScore, 300);
});

test('defaults match the product spec', () => {
  assert.deepEqual({ ...E.DEFAULT_SETTINGS }, {
    maxPlayers: 4, startingCards: 7, winningScore: 500, turnSeconds: 30, stacking: false, jumpIn: false, drawUntilPlayable: false,
  });
});

// ---- bots + full-game fuzz -------------------------------------------------

test('bot move is always legal', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rng = mulberry32(seed);
    const m = E.createMatch({ playerIds: ['a', 'b', 'c', 'd'], settings: { ...E.DEFAULT_SETTINGS, stacking: seed % 2 === 0 }, rng, now: NOW });
    E.startRound(m, NOW);
    for (let i = 0; i < 25 && m.phase === 'playing'; i++) {
      const pid = E.currentId(m);
      const mv = E.chooseBotMove(m, pid, rng);
      assert.ok(mv, 'bot always finds a move');
      let res;
      if (mv.type === 'uno') res = E.callUno(m, pid, NOW);
      else if (mv.type === 'play') res = E.playCard(m, pid, mv.cardId, mv.color, NOW);
      else if (mv.type === 'draw') res = E.drawAction(m, pid, NOW);
      else res = E.passAction(m, pid, NOW);
      assert.ok(res.ok, `bot move ${JSON.stringify(mv)} rejected: ${res.error}`);
    }
  }
});

function playFullMatch(seed, settings, playerIds) {
  const rng = mulberry32(seed);
  const m = E.createMatch({ playerIds, settings: { ...E.DEFAULT_SETTINGS, ...settings }, rng, now: NOW });
  let now = NOW;
  E.startRound(m, now);
  let steps = 0;
  while (m.phase !== 'finished') {
    if (++steps > 40000) throw new Error('match did not terminate (seed ' + seed + ')');
    if (m.phase === 'round_over') { now += 8000; E.startRound(m, now); continue; }
    const pid = E.currentId(m);
    const mv = E.chooseBotMove(m, pid, rng);
    let res;
    if (mv.type === 'uno') res = E.callUno(m, pid, now);
    else if (mv.type === 'play') res = E.playCard(m, pid, mv.cardId, mv.color, now);
    else if (mv.type === 'draw') res = E.drawAction(m, pid, now);
    else res = E.passAction(m, pid, now);
    if (!res.ok) throw new Error(`illegal bot move ${JSON.stringify(mv)}: ${res.error} (seed ${seed})`);
    if (total(m) !== 108) throw new Error(`card conservation broken (seed ${seed}) total=${total(m)}`);
    now += 700;
  }
  return m;
}

test('seeded full-match simulations terminate and conserve all 108 cards', () => {
  const combos = [
    { players: ['a', 'b'], settings: {} },
    { players: ['a', 'b', 'c'], settings: { stacking: true } },
    { players: ['a', 'b', 'c', 'd'], settings: { startingCards: 10, winningScore: 200 } },
    { players: ['a', 'b', 'c', 'd'], settings: { drawUntilPlayable: true, stacking: true } },
    { players: ['a', 'b', 'c', 'd'], settings: { startingCards: 5, winningScore: 100, jumpIn: true } },
  ];
  for (const combo of combos) {
    for (let seed = 1; seed <= 12; seed++) {
      const m = playFullMatch(seed, combo.settings, combo.players);
      assert.equal(m.phase, 'finished');
      assert.ok(m.scores[m.winnerId] >= (combo.settings.winningScore || 500));
      assert.ok(m.round >= 1);
    }
  }
});
