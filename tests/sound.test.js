'use strict';
// The sound kit is pure synthesis on top of the Web Audio graph. Node has no Web Audio, so this test gives it a
// recording stand-in: it checks that every effect can be scheduled without throwing, that the metal effects exist,
// and that every sound the metal voice swaps in is real. (Loudness and clipping were measured separately in a
// real browser with an OfflineAudioContext; see the README.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let kitMod;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'sound', 'kit.js'), 'utf8');
  kitMod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
});

/** A fake AudioContext: every node accepts any call, and we count the oscillators and noise sources that get started. */
function fakeContext() {
  const stats = { oscillators: 0, sources: 0, maxEnd: 0 };
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} });
  const node = (kind) => {
    const n = new Proxy({}, {
      get(target, key) {
        if (key in target) return target[key];
        if (key === 'connect') return () => n;
        if (key === 'start') return (t = 0) => { if (kind === 'osc') stats.oscillators++; else if (kind === 'src') stats.sources++; };
        if (key === 'stop') return (t = 0) => { if (t > stats.maxEnd) stats.maxEnd = t; };
        if (['frequency', 'gain', 'detune', 'Q', 'threshold', 'knee', 'ratio', 'attack', 'release'].includes(key)) return (target[key] = param());
        return () => {};
      },
      set(target, key, value) { target[key] = value; return true; },
    });
    return n;
  };
  const ctx = {
    sampleRate: 44100, currentTime: 0, destination: node('dest'),
    createGain: () => node('gain'), createDynamicsCompressor: () => node('comp'), createWaveShaper: () => node('shaper'),
    createConvolver: () => node('conv'), createBiquadFilter: () => node('filter'),
    createOscillator: () => node('osc'), createBufferSource: () => node('src'),
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
  };
  return { ctx, stats };
}

test('every effect can be scheduled, and each one makes a sound', () => {
  const { ctx, stats } = fakeContext();
  const kit = kitMod.createKit(ctx, { random: () => 0.5 });
  assert.ok(kit.names.length >= 25);
  for (const name of kit.names) {
    const before = stats.oscillators + stats.sources;
    assert.equal(kit.play(name), true, name);
    assert.ok(stats.oscillators + stats.sources > before, `${name} starts at least one voice`);
  }
  assert.equal(kit.play('no-such-sound'), false);
});

test('the metal card sounds exist, and everything the metal voice swaps in is real', () => {
  const { ctx } = fakeContext();
  const kit = kitMod.createKit(ctx, { random: () => 0.5 });
  for (const name of ['throw', 'clank', 'clang', 'slide', 'tink', 'rattle']) assert.ok(kit.names.includes(name), name);
  for (const [paper, metal] of Object.entries(kitMod.METAL_VOICE)) {
    assert.ok(kit.names.includes(paper), `${paper} still exists for printed cards`);
    assert.ok(kit.names.includes(metal), `${paper} becomes ${metal}`);
  }
});

test('a clank is a struck plate: several ringing partials, not a single tone, and it stays short', () => {
  const { ctx, stats } = fakeContext();
  const kit = kitMod.createKit(ctx, { random: () => 0.5 });
  const beforeOsc = stats.oscillators;
  kit.play('clank', 1);
  const clankOsc = stats.oscillators - beforeOsc;
  assert.ok(clankOsc >= 7, `clank layers ${clankOsc} partials`);
  assert.ok(stats.maxEnd < 2, 'it is over within two seconds');
  const b2 = stats.oscillators;
  kit.play('clang', 1);
  assert.ok(stats.oscillators - b2 > clankOsc, 'the heavier clang layers more partials');
});
