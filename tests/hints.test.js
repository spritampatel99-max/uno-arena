'use strict';
// hints.js is a dependency-free ES module; it is loaded through a data: URL so this works on any Node 20+
// without caring how the project marks its module type.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let mod;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'hints.js'), 'utf8');
  mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
});

let nid = 1;
const C = (color, kind, value = null) => ({ id: nid++, color, kind, value });

test('no playable card means no suggestion', () => {
  assert.equal(mod.suggestPlay({ hand: [C('red', 'num', 4)], playable: [], opponents: [] }), null);
});

test('a single legal card is the suggestion', () => {
  const a = C('red', 'num', 4);
  const r = mod.suggestPlay({ hand: [a, C('blue', 'num', 9)], playable: [a.id], opponents: [] });
  assert.equal(r.id, a.id);
  assert.match(r.reason, /only/i);
});

test('it only ever suggests a card the server marked playable', () => {
  const hand = [C('red', 'num', 9), C('red', 'num', 1), C('blue', 'draw2'), C(null, 'wild')];
  for (let mask = 1; mask < 16; mask++) {
    const playable = hand.filter((_, i) => mask & (1 << i)).map((c) => c.id);
    const r = mod.suggestPlay({ hand, playable, opponents: [{ name: 'Bot', cards: 5 }] });
    assert.ok(playable.includes(r.id));
  }
});

test('with nobody close to going out it sheds the highest-value card and saves the Wild', () => {
  const nine = C('red', 'num', 9); const two = C('red', 'num', 2); const wild = C(null, 'wild');
  const r = mod.suggestPlay({ hand: [nine, two, wild, C('blue', 'num', 5)], playable: [nine.id, two.id, wild.id], opponents: [{ name: 'Mia', cards: 6 }] });
  assert.equal(r.id, nine.id);
});

test('an opponent on one card makes an attack card the best play', () => {
  const nine = C('red', 'num', 9); const draw2 = C('red', 'draw2');
  const r = mod.suggestPlay({ hand: [nine, draw2, C('blue', 'num', 1)], playable: [nine.id, draw2.id], opponents: [{ name: 'Mia', cards: 1 }, { name: 'Kai', cards: 6 }] });
  assert.equal(r.id, draw2.id);
  assert.match(r.reason, /Mia/);
  assert.match(r.reason, /one card/);
});

test('a Wild is fine to spend when someone is about to go out', () => {
  const wild4 = C(null, 'wild4'); const three = C('green', 'num', 3);
  const r = mod.suggestPlay({ hand: [wild4, three], playable: [wild4.id, three.id], opponents: [{ name: 'Kai', cards: 2 }] });
  assert.equal(r.id, wild4.id);
});

test('ties are broken the same way every time', () => {
  const a = C('red', 'num', 5); const b = C('blue', 'num', 5);
  const input = { hand: [a, b], playable: [a.id, b.id], opponents: [] };
  assert.equal(mod.suggestPlay(input).id, mod.suggestPlay(input).id);
});

test('suggestColor names the colour held most, ignoring the card being played', () => {
  const played = C(null, 'wild');
  const hand = [C('blue', 'num', 1), C('blue', 'num', 2), C('green', 'num', 3), played];
  assert.equal(mod.suggestColor(hand, played.id), 'blue');
  assert.equal(mod.suggestColor([C('yellow', 'num', 1)], null), 'yellow');
  assert.ok(['red', 'blue', 'yellow', 'green'].includes(mod.suggestColor([], null)));
});

test('card points follow the scoring rules', () => {
  assert.equal(mod.cardPoints(C('red', 'num', 7)), 7);
  assert.equal(mod.cardPoints(C('red', 'skip')), 20);
  assert.equal(mod.cardPoints(C('red', 'reverse')), 20);
  assert.equal(mod.cardPoints(C('red', 'draw2')), 20);
  assert.equal(mod.cardPoints(C(null, 'wild')), 50);
  assert.equal(mod.cardPoints(C(null, 'wild4')), 50);
});
