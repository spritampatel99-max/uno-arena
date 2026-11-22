// A small QR Code generator (ISO/IEC 18004): byte mode, error-correction levels L/M/Q/H, versions 1 to 10.
// That holds up to 213 bytes at level M, which is plenty for an invitation link. It has no dependencies and
// is checked against a real QR decoder in the project's test run (see tests/qr.test.js).

const ECC_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};
const BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};
const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const MAX_VERSION = 10;

const bit = (n, i) => ((n >>> i) & 1) !== 0;

function rawModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const a = Math.floor(ver / 7) + 2;
    n -= (25 * a - 10) * a - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
const dataCodewords = (ver, ecl) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * BLOCKS[ecl][ver];

function alignPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

// ---- Reed-Solomon over GF(256), polynomial 0x11D
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
  return z;
}
function rsDivisor(degree) {
  const out = new Array(degree - 1).fill(0).concat([1]);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < out.length; j++) { out[j] = gfMul(out[j], root); if (j + 1 < out.length) out[j] ^= out[j + 1]; }
    root = gfMul(root, 0x02);
  }
  return out;
}
function rsRemainder(data, divisor) {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ out.shift();
    out.push(0);
    divisor.forEach((c, i) => { out[i] ^= gfMul(c, factor); });
  }
  return out;
}

function utf8(text) { return Array.from(new TextEncoder().encode(String(text))); }

function buildCodewords(bytes, ver, ecl) {
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const cap = dataCodewords(ver, ecl) * 8;
  push(0, Math.min(4, cap - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

  const nBlocks = BLOCKS[ecl][ver];
  const eccLen = ECC_PER_BLOCK[ecl][ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const nShort = nBlocks - (raw % nBlocks);
  const shortLen = Math.floor(raw / nBlocks);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((blk, j) => { if (i !== shortLen - eccLen || j >= nShort) out.push(blk[i]); });
  }
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0,
  (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0,
];

function penalty(m, size) {
  let p = 0;
  const line = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      let hist = '';
      for (let b = 0; b < size; b++) {
        const v = get(a, b);
        hist += v ? '1' : '0';
        if (b > 0 && v === get(a, b - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; } else run = 1;
      }
      for (let i = 0; i + 11 <= size; i++) {
        const s = hist.substr(i, 11);
        if (s === '10111010000' || s === '00001011101') p += 40;
      }
    }
  };
  line((y, x) => m[y][x]);
  line((x, y) => m[y][x]);
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const v = m[y][x];
    if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) p += 3;
  }
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const total = size * size;
  p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return p;
}

/**
 * Build a QR symbol.
 * @param {string} text   encoded as UTF-8 bytes
 * @param {'L'|'M'|'Q'|'H'} [ecl]
 * @returns {{ size: number, version: number, mask: number, modules: boolean[][] }}
 */
export function makeQr(text, ecl = 'M') {
  if (!FORMAT_BITS.hasOwnProperty(ecl)) throw new Error('bad error-correction level');
  const bytes = utf8(text);
  let ver = 1;
  for (; ver <= MAX_VERSION; ver++) {
    const used = 4 + (ver < 10 ? 8 : 16) + bytes.length * 8;
    if (used <= dataCodewords(ver, ecl) * 8) break;
  }
  if (ver > MAX_VERSION) throw new Error('text is too long for this QR generator');

  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true; };

  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx; const y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, Math.max(Math.abs(dx), Math.abs(dy)) !== 2 && Math.max(Math.abs(dx), Math.abs(dy)) !== 4);
    }
  };
  const formatBits = (mask) => {
    const data = (FORMAT_BITS[ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(bits, i));
    setFn(8, 7, bit(bits, 6)); setFn(8, 8, bit(bits, 7)); setFn(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(bits, i));
    setFn(8, size - 8, true);
  };

  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const ap = alignPositions(ver);
  ap.forEach((ay, i) => ap.forEach((ax, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  formatBits(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3); const b = Math.floor(i / 3);
      setFn(a, b, bit(bits, i)); setFn(b, a, bit(bits, i));
    }
  }

  // place the data, zig-zagging up and down two-column strips from the right
  const codewords = buildCodewords(bytes, ver, ecl);
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!isFn[y][x] && k < codewords.length * 8) { modules[y][x] = bit(codewords[k >>> 3], 7 - (k & 7)); k++; }
    }
  }

  // pick the mask with the lowest penalty
  const applyMask = (n) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && MASKS[n](x, y)) modules[y][x] = !modules[y][x]; };
  let best = 0; let bestScore = Infinity;
  for (let n = 0; n < 8; n++) {
    applyMask(n); formatBits(n);
    const score = penalty(modules, size);
    if (score < bestScore) { best = n; bestScore = score; }
    applyMask(n); // XOR again to undo
  }
  applyMask(best); formatBits(best);
  return { size, version: ver, mask: best, modules };
}

/** A self-contained SVG string: one path, crisp at any size, with the four-module quiet zone the spec asks for. */
export function qrSvg(qr, { border = 4, dark = '#0b1020', light = '#ffffff', label = 'QR code' } = {}) {
  const parts = [];
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.modules[y][x]) { x++; continue; }
      let run = 1;
      while (x + run < qr.size && qr.modules[y][x + run]) run++;
      parts.push(`M${x + border} ${y + border}h${run}v1h-${run}z`);
      x += run;
    }
  }
  const dim = qr.size + border * 2;
  const esc = String(label).replace(/[<>&"]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="${esc}"><rect width="${dim}" height="${dim}" fill="${light}"/><path d="${parts.join('')}" fill="${dark}"/></svg>`;
}
