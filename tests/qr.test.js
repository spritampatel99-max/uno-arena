'use strict';
// The QR generator is a dependency-free ES module, loaded through a data: URL so this runs on any Node 20+.
// The golden hashes below were produced by this generator and confirmed by decoding the same symbols with
// OpenCV's QR decoder (versions 1 to 10, all four error-correction levels, all eight masks). A hash change
// means the output changed: decode a sample again before updating it.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

let qr;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'qr.js'), 'utf8');
  qr = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
});

const fingerprint = (q) => crypto.createHash('sha256').update(q.modules.map((r) => r.map((v) => (v ? 1 : 0)).join('')).join('\n')).digest('hex').slice(0, 16);

const GOLDEN = [
  ['https://uno.example/?room=ABC234', 'M', 3, 4, 'e69a8a973edcb2d1'],
  ['A', 'L', 1, 0, 'f195dbbdf146dae0'],
  ['HELLO WORLD', 'H', 2, 2, 'e4bb824acb2eea92'],
  ['http://192.168.1.23:3000/?room=K7P3QX', 'Q', 4, 4, 'f33af8dd015c6675'],
  ['x'.repeat(150), 'M', 8, 2, '9782fa7f0642d3e6'],
  ['Café ♠ 日本', 'M', 2, 5, 'c3fcd47bb0de0f81'],
];

test('output matches symbols that a real decoder read back correctly', () => {
  for (const [text, ecl, version, mask, hash] of GOLDEN) {
    const q = qr.makeQr(text, ecl);
    assert.equal(q.version, version, `${ecl} version for ${text.slice(0, 20)}`);
    assert.equal(q.mask, mask, 'mask choice');
    assert.equal(fingerprint(q), hash, `${ecl} modules for ${text.slice(0, 20)}`);
  }
});

test('size follows the version and the three finder patterns are in place', () => {
  const q = qr.makeQr('https://uno.example/?room=ABC234', 'M');
  assert.equal(q.size, q.version * 4 + 17);
  const finderOk = (x0, y0) => {
    for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
      const edge = dx === 0 || dx === 6 || dy === 0 || dy === 6;
      const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      if (q.modules[y0 + dy][x0 + dx] !== (edge || core)) return false;
    }
    return true;
  };
  assert.ok(finderOk(0, 0) && finderOk(q.size - 7, 0) && finderOk(0, q.size - 7));
  assert.equal(q.modules[q.size - 8][8], true, 'the fixed dark module');
  for (let i = 8; i < q.size - 8; i++) assert.equal(q.modules[6][i], i % 2 === 0, 'timing row');
});

test('format information is a valid BCH word naming the level and mask', () => {
  const q = qr.makeQr('hello', 'Q');
  let bits = 0;
  for (let i = 0; i <= 5; i++) bits |= (q.modules[i][8] ? 1 : 0) << i;
  bits |= (q.modules[7][8] ? 1 : 0) << 6; bits |= (q.modules[8][8] ? 1 : 0) << 7; bits |= (q.modules[8][7] ? 1 : 0) << 8;
  for (let i = 9; i < 15; i++) bits |= (q.modules[8][14 - i] ? 1 : 0) << i;
  const data = (bits ^ 0x5412) >>> 10;
  assert.equal(data >>> 3, 3, 'level Q is 11 in binary');
  assert.equal(data & 7, q.mask);
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  assert.equal(((data << 10) | rem) ^ 0x5412, bits, 'BCH remainder matches');
});

test('the generator is deterministic and picks the smallest version that fits', () => {
  assert.equal(fingerprint(qr.makeQr('same', 'M')), fingerprint(qr.makeQr('same', 'M')));
  assert.equal(qr.makeQr('a'.repeat(14), 'M').version, 1);
  assert.equal(qr.makeQr('a'.repeat(15), 'M').version, 2);
  assert.equal(qr.makeQr('a'.repeat(213), 'M').version, 10);
});

test('input that cannot fit, or a bad level, is rejected', () => {
  assert.throws(() => qr.makeQr('a'.repeat(214), 'M'), /too long/);
  assert.throws(() => qr.makeQr('hi', 'Z'), /level/);
});

test('the SVG is one self-contained path with a quiet zone and no markup injection', () => {
  const q = qr.makeQr('https://uno.example/?room=ABC234', 'M');
  const svg = qr.qrSvg(q, { label: 'Join <room> & play' });
  assert.match(svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
  assert.equal((svg.match(/<path /g) || []).length, 1);
  assert.ok(svg.includes(`viewBox="0 0 ${q.size + 8} ${q.size + 8}"`));
  assert.ok(!/<room>|&play/.test(svg), 'label is stripped of markup characters');
  assert.ok(!svg.includes('<script'));
});
