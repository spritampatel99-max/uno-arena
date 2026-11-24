// UNO ARENA sound kit.
//
// Every effect (and the ambient music) is synthesised from oscillators and filtered noise, then run through
// a shared reverb and a limiter. There are no audio files to download or license.
//
// The kit only needs a BaseAudioContext, so the exact same code runs live in the browser and offline
// (the test-suite renders each sound with an OfflineAudioContext and checks level, length and clipping).

/**
 * While the cards are metal, these paper-card effects are swapped for their steel counterparts (see audio.js).
 * A card landing on the table is separate: the screens call audio.land(card), which plays clank or clang.
 */
export const METAL_VOICE = { play: 'throw', draw: 'slide', flick: 'tink', shuffle: 'rattle' };

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

function makeImpulse(ctx, seconds, decay, rnd) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const k = 1 - i / len;
      d[i] = (rnd() * 2 - 1) * Math.pow(k, decay);
    }
  }
  return buf;
}

export function createKit(ctx, { random = Math.random, sfxVolume = 0.6, musicVolume = 0.35 } = {}) {
  const rnd = random;

  // ------------------------------------------------------------------ buses
  const master = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -9; limiter.knee.value = 12; limiter.ratio.value = 10; limiter.attack.value = 0.003; limiter.release.value = 0.2;
  // a gentle tanh soft-clipper after the limiter guarantees the output can never exceed full scale,
  // even when several big effects land together
  const softClip = ctx.createWaveShaper();
  { const n = 1024; const c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * 1.1) / Math.tanh(1.1) * 0.9; } softClip.curve = c; softClip.oversample = '2x'; }
  master.connect(limiter); limiter.connect(softClip); softClip.connect(ctx.destination);

  function makeBus(level, verbSeconds, verbDecay, verbLevel) {
    const out = ctx.createGain(); out.gain.value = level; out.connect(master);
    const dry = ctx.createGain(); dry.connect(out);
    const send = ctx.createGain();
    const verb = ctx.createConvolver(); verb.buffer = makeImpulse(ctx, verbSeconds, verbDecay, rnd);
    const wet = ctx.createGain(); wet.gain.value = verbLevel;
    send.connect(verb); verb.connect(wet); wet.connect(out);
    return { out, dry, send };
  }
  const sfxBus = makeBus(sfxVolume, 1.5, 2.8, 0.55);
  const musicBus = makeBus(musicVolume, 3.2, 2.2, 0.8);
  const musicIn = ctx.createGain(); // fades the music in/out without touching the user's volume
  musicIn.connect(musicBus.dry);
  const musicSendIn = ctx.createGain();
  musicSendIn.connect(musicBus.send);

  const noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
  { const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1; }

  // ------------------------------------------------------------------ voices
  function route(g, bus, send) {
    if (bus === 'music') {
      g.connect(musicIn);
      if (send) { const s = ctx.createGain(); s.gain.value = send; g.connect(s); s.connect(musicSendIn); }
    } else {
      g.connect(sfxBus.dry);
      if (send) { const s = ctx.createGain(); s.gain.value = send; g.connect(s); s.connect(sfxBus.send); }
    }
  }

  function tone(t, { f, f2 = null, dur = 0.2, vol = 0.3, type = 'sine', attack = 0.004, hold = 0, detune = 0, send = 0, bus = 'sfx', lp = null, vib = null }) {
    const end = Math.max(t + attack + hold + 0.02, t + dur);
    const o = ctx.createOscillator();
    o.type = type; o.detune.value = detune;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), end);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    if (hold) g.gain.setValueAtTime(vol, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    let node = o;
    if (lp) { const flt = ctx.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = lp; o.connect(flt); node = flt; }
    node.connect(g);
    route(g, bus, send);
    if (vib) {
      const l = ctx.createOscillator(); l.frequency.value = vib.rate;
      const lg = ctx.createGain(); lg.gain.value = vib.depth;
      l.connect(lg); lg.connect(o.detune); l.start(t); l.stop(end + 0.05);
    }
    o.start(t); o.stop(end + 0.05);
  }

  function noise(t, { dur = 0.1, vol = 0.3, type = 'bandpass', f = 2000, f2 = null, q = 1, attack = 0.002, send = 0, bus = 'sfx' }) {
    const end = t + Math.max(dur, attack + 0.01);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = type; flt.Q.value = q;
    flt.frequency.setValueAtTime(f, t);
    if (f2) flt.frequency.exponentialRampToValueAtTime(Math.max(40, f2), end);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    src.connect(flt); flt.connect(g);
    route(g, bus, send);
    src.start(t, rnd() * 1.0); src.stop(end + 0.05);
  }

  /** A struck-bell timbre: fundamental plus inharmonic partials. */
  function bell(t, f, { vol = 0.2, dur = 0.9, send = 0.5, bus = 'sfx' } = {}) {
    tone(t, { f, dur, vol, attack: 0.002, send, bus });
    tone(t, { f: f * 2.76, dur: dur * 0.55, vol: vol * 0.35, attack: 0.002, send, bus });
    tone(t, { f: f * 5.4, dur: dur * 0.28, vol: vol * 0.12, attack: 0.002, send, bus });
  }

  /** A soft brass-like stab: two detuned saws through a low-pass. */
  function stab(t, f, { vol = 0.12, dur = 0.5, lp = 2400, send = 0.3 } = {}) {
    tone(t, { f, dur, vol, type: 'sawtooth', detune: -7, lp, attack: 0.012, send });
    tone(t, { f, dur, vol, type: 'sawtooth', detune: 7, lp, attack: 0.012, send });
  }

  /**
   * A struck steel plate. A free plate rings at inharmonic partials (about 1 : 2.76 : 5.4 : 8.9), the higher ones dying
   * first; a slightly detuned twin of the lowest two makes the ring beat the way real metal does.
   */
  function plate(t, f, { vol = 0.2, dur = 0.45, send = 0.3 } = {}) {
    const ratio = [1, 2.76, 5.4, 8.93];
    const level = [1, 0.7, 0.42, 0.2];
    const decay = [1, 0.62, 0.36, 0.2];
    ratio.forEach((r, i) => {
      tone(t, { f: f * r, dur: dur * decay[i], vol: vol * level[i], attack: 0.001, send });
      if (i < 2) tone(t, { f: f * r * 1.009, dur: dur * decay[i] * 0.9, vol: vol * level[i] * 0.6, attack: 0.001, send });
    });
  }

  // ------------------------------------------------------------------ effects
  // each effect: (t, v) where t is the start time and v a small random pitch factor so repeats never sound identical
  const thud = (t, v, vol = 0.4) => tone(t, { f: 150 * v, f2: 58, dur: 0.16, vol, send: 0.1 });

  const FX = {
    click: (t, v) => { tone(t, { f: 560 * v, f2: 380 * v, dur: 0.05, vol: 0.2, type: 'triangle' }); noise(t, { dur: 0.02, vol: 0.06, type: 'highpass', f: 4200 }); },
    hover: (t, v) => tone(t, { f: 1500 * v, dur: 0.03, vol: 0.1 }),
    flick: (t, v) => { noise(t, { dur: 0.08, vol: 0.55, f: 2300 * v, f2: 5200, q: 0.9 }); tone(t, { f: 1900 * v, dur: 0.02, vol: 0.07, type: 'triangle' }); },
    draw: (t, v) => { noise(t, { dur: 0.17, vol: 0.55, f: 900 * v, f2: 3800, q: 1.1 }); tone(t, { f: 330 * v, f2: 210, dur: 0.1, vol: 0.1, type: 'triangle' }); },
    play: (t, v) => {
      noise(t, { dur: 0.05, vol: 0.5, type: 'highpass', f: 1500 });
      noise(t, { dur: 0.1, vol: 0.24, f: 3000 * v, q: 0.8 });
      thud(t, v, 0.36);
    },
    shuffle: (t, v) => {
      for (let i = 0; i < 15; i++) {
        const k = 1 - Math.abs(i - 7) / 9;
        noise(t + i * 0.04 + rnd() * 0.012, { dur: 0.04, vol: 0.07 + k * 0.13, f: (1800 + rnd() * 2600) * v, q: 1.2 });
      }
      thud(t + 0.66, v, 0.22);
    },
    // ---- metal cards (the facade maps play/draw/flick/shuffle here while Card material is Metal) ----
    // leaving the hand: a short edge-on slide through the air
    throw: (t, v) => {
      noise(t, { dur: 0.15, vol: 0.34, f: 1700 * v, f2: 6200, q: 1.3 });
      noise(t + 0.02, { dur: 0.09, vol: 0.07, type: 'highpass', f: 6500 });
    },
    // landing on the table: contact click, ringing plate, a bright "tss", and the table underneath
    clank: (t, v) => {
      noise(t, { dur: 0.012, vol: 0.42, type: 'highpass', f: 3500 });
      plate(t, 1050 * v, { vol: 0.13, dur: 0.38, send: 0.18 });
      noise(t, { dur: 0.08, vol: 0.14, f: 4300 * v, q: 6 });
      thud(t, v, 0.3);
    },
    // action and wild cards: a heavier plate, a lower ring, a longer tail
    clang: (t, v) => {
      noise(t, { dur: 0.014, vol: 0.5, type: 'highpass', f: 2800 });
      plate(t, 760 * v, { vol: 0.17, dur: 0.62, send: 0.26 });
      plate(t + 0.011, 1320 * v, { vol: 0.08, dur: 0.34, send: 0.22 });
      noise(t, { dur: 0.12, vol: 0.15, f: 3400 * v, q: 5 });
      thud(t, v, 0.4);
    },
    // a card sliding off the deck
    slide: (t, v) => {
      noise(t, { dur: 0.2, vol: 0.4, f: 1300 * v, f2: 4300, q: 3.2 });
      noise(t + 0.01, { dur: 0.1, vol: 0.1, type: 'highpass', f: 5200 });
      plate(t + 0.17, 1500 * v, { vol: 0.05, dur: 0.18, send: 0.2 });
    },
    // one card being dealt
    tink: (t, v) => {
      noise(t, { dur: 0.012, vol: 0.28, type: 'highpass', f: 4200 });
      plate(t, 1700 * v, { vol: 0.07, dur: 0.12, send: 0.2 });
    },
    // the whole deck riffled: a run of tiny ticks with the odd bright ring
    rattle: (t, v) => {
      for (let i = 0; i < 15; i++) {
        const k = 1 - Math.abs(i - 7) / 9;
        const at = t + i * 0.04 + rnd() * 0.012;
        noise(at, { dur: 0.035, vol: 0.06 + k * 0.12, f: (2400 + rnd() * 3000) * v, q: 2 });
        if (i % 5 === 2) plate(at, (1400 + rnd() * 700) * v, { vol: 0.035, dur: 0.14, send: 0.25 });
      }
      thud(t + 0.66, v, 0.22);
      plate(t + 0.66, 900 * v, { vol: 0.07, dur: 0.3, send: 0.3 });
    },
    skip: (t, v) => {
      thud(t, v, 0.34);
      tone(t + 0.02, { f: 440 * v, f2: 392 * v, dur: 0.13, vol: 0.13, type: 'triangle', send: 0.2 });
      tone(t + 0.14, { f: 330 * v, f2: 247 * v, dur: 0.24, vol: 0.14, type: 'triangle', send: 0.25 });
      noise(t, { dur: 0.22, vol: 0.12, f: 2600, f2: 500 });
    },
    reverse: (t, v) => {
      noise(t, { dur: 0.24, vol: 0.26, f: 350, f2: 3200, q: 1.4, send: 0.2 });
      noise(t + 0.22, { dur: 0.26, vol: 0.26, f: 3200, f2: 380, q: 1.4, send: 0.2 });
      tone(t, { f: 260 * v, f2: 780 * v, dur: 0.24, vol: 0.08, type: 'sine' });
      tone(t + 0.22, { f: 780 * v, f2: 260 * v, dur: 0.26, vol: 0.08, type: 'sine' });
    },
    wild: (t, v) => { [72, 76, 79, 84, 88].forEach((n, i) => bell(t + i * 0.055, midi(n) * v, { vol: 0.14, dur: 0.8, send: 0.55 })); noise(t, { dur: 0.35, vol: 0.07, type: 'highpass', f: 5200, f2: 9000 }); },
    color: (t, v) => { bell(t, midi(79) * v, { vol: 0.16, dur: 0.7, send: 0.5 }); bell(t + 0.08, midi(86) * v, { vol: 0.12, dur: 0.7, send: 0.5 }); },
    penalty: (t, v) => {
      tone(t, { f: 180 * v, f2: 70, dur: 0.34, vol: 0.3, type: 'sawtooth', lp: 900, send: 0.15 });
      noise(t, { dur: 0.28, vol: 0.22, type: 'lowpass', f: 600, f2: 120 });
    },
    slam: (t, v) => {
      tone(t, { f: 120 * v, f2: 34, dur: 0.55, vol: 0.55, send: 0.2 });
      noise(t, { dur: 0.45, vol: 0.34, type: 'lowpass', f: 900, f2: 90, send: 0.2 });
      noise(t, { dur: 0.05, vol: 0.4, type: 'highpass', f: 1800 });
      stab(t + 0.01, midi(42) * v, { vol: 0.1, dur: 0.42, lp: 1200 });
      stab(t + 0.01, midi(48) * v, { vol: 0.08, dur: 0.42, lp: 1200 });
    },
    uno: (t, v) => {
      stab(t, midi(79) * v, { vol: 0.1, dur: 0.2, lp: 3600 });
      stab(t + 0.13, midi(86) * v, { vol: 0.11, dur: 0.4, lp: 4200 });
      bell(t + 0.13, midi(98) * v, { vol: 0.09, dur: 0.6, send: 0.5 });
    },
    caught: (t, v) => {
      tone(t, { f: 392 * v, f2: 196 * v, dur: 0.34, vol: 0.24, type: 'sawtooth', lp: 1300, vib: { rate: 9, depth: 25 }, send: 0.15 });
      noise(t, { dur: 0.03, vol: 0.16, type: 'highpass', f: 3000 });
    },
    turn: (t, v) => { bell(t, midi(76) * v, { vol: 0.17, dur: 0.7, send: 0.45 }); bell(t + 0.1, midi(83) * v, { vol: 0.14, dur: 0.8, send: 0.5 }); },
    tick: (t, v) => { tone(t, { f: 1900 * v, f2: 1200, dur: 0.04, vol: 0.3, type: 'triangle' }); noise(t, { dur: 0.018, vol: 0.12, f: 3200, q: 2 }); },
    // a new chat message: two soft bell tones, quieter than a game sound so it never competes with the table
    chat: (t, v) => { tone(t, { f: midi(81) * v, dur: 0.16, vol: 0.07, type: 'sine', send: 0.25 }); tone(t + 0.07, { f: midi(86) * v, dur: 0.22, vol: 0.075, type: 'sine', send: 0.3 }); },
    join: (t, v) => { tone(t, { f: midi(69) * v, dur: 0.22, vol: 0.14, type: 'triangle', send: 0.3 }); tone(t + 0.09, { f: midi(76) * v, dur: 0.3, vol: 0.15, type: 'triangle', send: 0.35 }); },
    leave: (t, v) => { tone(t, { f: midi(76) * v, dur: 0.2, vol: 0.12, type: 'triangle', send: 0.3 }); tone(t + 0.09, { f: midi(69) * v, dur: 0.3, vol: 0.12, type: 'triangle', send: 0.35 }); },
    error: (t, v) => { tone(t, { f: 160 * v, dur: 0.09, vol: 0.12, type: 'square', lp: 700 }); tone(t + 0.1, { f: 130 * v, dur: 0.14, vol: 0.12, type: 'square', lp: 700 }); },
    countdown: (t, v) => { bell(t, midi(81) * v, { vol: 0.17, dur: 0.5, send: 0.3 }); thud(t, 1, 0.14); },
    go: (t, v) => {
      [60, 64, 67, 72].forEach((n, i) => stab(t + i * 0.012, midi(n) * v, { vol: 0.08, dur: 0.55, lp: 3000 }));
      bell(t, midi(84) * v, { vol: 0.14, dur: 1, send: 0.5 });
      noise(t, { dur: 0.4, vol: 0.12, f: 400, f2: 6000, q: 0.7 });
    },
    roundWin: (t, v) => { [72, 76, 79, 84].forEach((n, i) => bell(t + i * 0.09, midi(n) * v, { vol: 0.16, dur: 1, send: 0.55 })); },
    win: (t, v) => {
      [[60, 64, 67], [65, 69, 72], [67, 71, 74], [72, 76, 79, 84]].forEach((chord, i) => chord.forEach((n) => stab(t + i * 0.22, midi(n) * v, { vol: 0.07, dur: i === 3 ? 1.4 : 0.34, lp: 3200, send: 0.4 })));
      [84, 88, 91, 96, 100].forEach((n, i) => bell(t + 0.7 + i * 0.1, midi(n) * v, { vol: 0.11, dur: 1.1, send: 0.6 }));
      thud(t, 1, 0.22);
    },
    lose: (t, v) => { [69, 67, 64, 62].forEach((n, i) => tone(t + i * 0.2, { f: midi(n) * v, dur: 0.6, vol: 0.13, type: 'triangle', lp: 1500, send: 0.55 })); },
    emote: (t, v) => { tone(t, { f: 480 * v, f2: 1000 * v, dur: 0.09, vol: 0.14, type: 'sine', send: 0.2 }); bell(t + 0.07, midi(88) * v, { vol: 0.06, dur: 0.3, send: 0.4 }); },
    hint: (t, v) => { bell(t, midi(91) * v, { vol: 0.1, dur: 0.5, send: 0.5 }); },
  };

  // ------------------------------------------------------------------ ambient music
  // A slow Am7 – Fmaj7 – C – Gmaj7 loop: warm pad, soft bass and kick, hushed hats and sparse pentatonic plucks
  // with echoes. It is generated bar by bar, so it never repeats exactly and costs no download.
  const BPM = 74;
  const STEP = 60 / BPM / 2; // eighth note
  const CHORDS = [
    { root: 45, pad: [57, 60, 64, 67] },
    { root: 41, pad: [53, 57, 60, 64] },
    { root: 48, pad: [55, 60, 64, 67] },
    { root: 43, pad: [55, 59, 62, 66] },
  ];
  const SCALE = [69, 72, 74, 76, 79, 81, 84];
  const M = { timer: null, running: false, nextT: 0, n: 0 };

  function musicStep(t, n) {
    const ci = Math.floor(n / 16) % CHORDS.length;
    const c = CHORDS[ci];
    const s16 = n % 16;
    const swing = n % 2 ? STEP * 0.14 : 0;
    const tt = t + swing;
    if (s16 === 0) {
      const padDur = STEP * 16 + 1.4;
      for (const note of c.pad) {
        tone(t, { f: midi(note), dur: padDur, vol: 0.028, type: 'sawtooth', detune: -6, lp: 760, attack: 1.3, hold: STEP * 12, bus: 'music', send: 0.5 });
        tone(t, { f: midi(note), dur: padDur, vol: 0.028, type: 'sawtooth', detune: 6, lp: 760, attack: 1.3, hold: STEP * 12, bus: 'music', send: 0.5 });
      }
    }
    if (s16 % 8 === 0) tone(t, { f: midi(c.root), dur: STEP * 6, vol: 0.12, type: 'sine', attack: 0.02, bus: 'music' });
    if (s16 % 8 === 0) tone(t, { f: 118, f2: 44, dur: 0.18, vol: 0.14, bus: 'music' });
    if (s16 % 8 === 5) tone(tt, { f: 100, f2: 44, dur: 0.14, vol: 0.07, bus: 'music' });
    if (n % 2 === 1) noise(tt, { dur: 0.05, vol: 0.012 + (s16 % 4 === 1 ? 0.006 : 0), type: 'highpass', f: 7000, bus: 'music' });
    if (n % 4 === 2 && s16 % 8 !== 0) noise(tt, { dur: 0.09, vol: 0.02, f: 2600, q: 0.8, bus: 'music' }); // soft snare-ish brush
    if (n % 2 === 0 && rnd() < (s16 > 11 ? 0.5 : 0.34)) {
      const chordTones = c.pad.map((x) => x + 12);
      const pool = rnd() < 0.55 ? SCALE.filter((x) => chordTones.some((ct) => (ct - x) % 12 === 0)) : SCALE;
      const note = (pool.length ? pool : SCALE)[Math.floor(rnd() * (pool.length ? pool.length : SCALE.length))];
      const f = midi(note);
      const pluck = (when, vol) => {
        tone(when, { f, dur: 1.0, vol, type: 'triangle', attack: 0.004, bus: 'music', send: 0.7 });
        tone(when, { f: f * 2, dur: 0.35, vol: vol * 0.3, type: 'sine', attack: 0.004, bus: 'music', send: 0.7 });
      };
      pluck(tt, 0.05);
      pluck(tt + STEP * 1.5, 0.02);
      pluck(tt + STEP * 3, 0.008);
    }
  }

  const music = {
    get running() { return M.running; },
    /** Prime the sequencer at time t (used live and by offline tests). */
    begin(t) { M.nextT = t; M.n = 0; },
    /** Schedule every step that starts before `until`. */
    scheduleSteps(until) {
      while (M.nextT < until) { musicStep(M.nextT, M.n); M.nextT += STEP; M.n++; }
    },
    start() {
      if (M.running) return;
      M.running = true;
      musicIn.gain.cancelScheduledValues(ctx.currentTime);
      musicIn.gain.setValueAtTime(musicIn.gain.value, ctx.currentTime);
      musicIn.gain.linearRampToValueAtTime(1, ctx.currentTime + 1.2);
      music.begin(ctx.currentTime + 0.12);
      music.scheduleSteps(ctx.currentTime + 1.2);
      M.timer = setInterval(() => music.scheduleSteps(ctx.currentTime + 1.2), 250);
    },
    stop() {
      if (!M.running) return;
      M.running = false;
      clearInterval(M.timer); M.timer = null;
      musicIn.gain.cancelScheduledValues(ctx.currentTime);
      musicIn.gain.setValueAtTime(musicIn.gain.value, ctx.currentTime);
      musicIn.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.5);
    },
    /** Briefly lower the music under a big sound effect. */
    duck(ms = 900, depth = 0.45) {
      if (!M.running) return;
      const t = ctx.currentTime;
      musicIn.gain.cancelScheduledValues(t);
      musicIn.gain.setValueAtTime(musicIn.gain.value, t);
      musicIn.gain.linearRampToValueAtTime(depth, t + 0.08);
      musicIn.gain.linearRampToValueAtTime(1, t + ms / 1000);
    },
  };
  musicIn.gain.value = 0;

  // ------------------------------------------------------------------ public api
  return {
    ctx,
    names: Object.keys(FX),
    music,
    play(name, when) {
      const fn = FX[name];
      if (!fn) return false;
      const t = Math.max(when === undefined ? ctx.currentTime : when, ctx.currentTime);
      fn(t, 0.96 + rnd() * 0.08);
      return true;
    },
    setSfxVolume(v) { sfxBus.out.gain.value = Math.min(4, Math.max(0, v)); },
    setMusicVolume(v) { musicBus.out.gain.value = Math.min(4, Math.max(0, v)); },
    /** For tests: the master gain node, so an offline render can be captured at one place. */
    master,
    /** For tests: skip the fade-in so a short offline render is audible from the first beat. */
    openMusic() { musicIn.gain.value = 1; },
  };
}
