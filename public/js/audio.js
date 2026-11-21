// Synthesised sound effects (Web Audio) — no audio files, no autoplay.
// Sound starts DISABLED; the AudioContext is only created after the player switches it on (a user gesture).
import { store, setPrefs } from './store.js';

let ctx = null;
let master = null;
let noiseBuf = null;

function ensure() {
  if (!store.prefs.sound) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = store.prefs.volume;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp);
    comp.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone(freq, dur, { type = 'sine', vol = 0.5, at = 0, slide = null, attack = 0.005 } = {}) {
  const c = ensure();
  if (!c) return;
  const t = c.currentTime + at;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.05);
}

function noise(dur, { freq = 2200, q = 1.2, vol = 0.5, at = 0, type = 'bandpass' } = {}) {
  const c = ensure();
  if (!c) return;
  const t = c.currentTime + at;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const f = c.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t, Math.random() * 0.2, dur + 0.05);
}

const SFX = {
  click: () => tone(640, 0.06, { type: 'triangle', vol: 0.25 }),
  hover: () => tone(900, 0.03, { type: 'sine', vol: 0.06 }),
  deal: () => { noise(0.08, { freq: 3000, vol: 0.35 }); },
  draw: () => { noise(0.1, { freq: 2600, vol: 0.4 }); tone(300, 0.08, { type: 'triangle', vol: 0.12, slide: 180 }); },
  play: () => { noise(0.07, { freq: 1800, vol: 0.5 }); tone(190, 0.14, { type: 'triangle', vol: 0.4, slide: 90 }); },
  skip: () => { tone(520, 0.12, { type: 'square', vol: 0.12 }); tone(330, 0.2, { type: 'square', vol: 0.12, at: 0.1 }); },
  reverse: () => tone(300, 0.35, { type: 'sawtooth', vol: 0.1, slide: 800 }),
  wild: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, { type: 'triangle', vol: 0.22, at: i * 0.07 })),
  penalty: () => { tone(140, 0.3, { type: 'sawtooth', vol: 0.22, slide: 70 }); noise(0.25, { freq: 400, vol: 0.3, type: 'lowpass' }); },
  uno: () => { tone(880, 0.16, { type: 'square', vol: 0.18 }); tone(1320, 0.3, { type: 'square', vol: 0.18, at: 0.12 }); },
  caught: () => { tone(420, 0.1, { type: 'square', vol: 0.2 }); tone(300, 0.25, { type: 'square', vol: 0.2, at: 0.1, slide: 150 }); },
  turn: () => { tone(988, 0.12, { type: 'sine', vol: 0.28 }); tone(1318, 0.2, { type: 'sine', vol: 0.2, at: 0.09 }); },
  tick: () => tone(1500, 0.04, { type: 'square', vol: 0.1 }),
  join: () => { tone(660, 0.1, { type: 'triangle', vol: 0.22 }); tone(990, 0.18, { type: 'triangle', vol: 0.22, at: 0.09 }); },
  leave: () => { tone(660, 0.1, { type: 'triangle', vol: 0.18 }); tone(440, 0.18, { type: 'triangle', vol: 0.18, at: 0.09 }); },
  error: () => tone(170, 0.16, { type: 'square', vol: 0.18, slide: 120 }),
  countdown: () => tone(780, 0.12, { type: 'sine', vol: 0.3 }),
  go: () => { tone(1040, 0.3, { type: 'sine', vol: 0.32 }); tone(1560, 0.3, { type: 'sine', vol: 0.2 }); },
  roundWin: () => [523, 659, 784].forEach((f, i) => tone(f, 0.22, { type: 'triangle', vol: 0.25, at: i * 0.1 })),
  win: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.4, { type: 'triangle', vol: 0.28, at: i * 0.12 })),
  lose: () => [392, 349, 311, 262].forEach((f, i) => tone(f, 0.3, { type: 'sine', vol: 0.22, at: i * 0.16 })),
};

export const audio = {
  get enabled() { return !!store.prefs.sound; },
  setEnabled(on) {
    setPrefs({ sound: !!on });
    if (on) { ensure(); setTimeout(() => SFX.click(), 30); }
  },
  setVolume(v) {
    const vol = Math.min(1, Math.max(0, v));
    setPrefs({ volume: vol });
    if (master) master.gain.value = vol;
  },
  play(name) {
    if (!store.prefs.sound) return;
    const fn = SFX[name];
    if (fn) { try { fn(); } catch (_) { /* audio is best-effort */ } }
  },
};
