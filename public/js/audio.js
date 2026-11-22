// Sound facade: preferences, the AudioContext lifecycle and a tiny play() API for the screens.
// Sound and music both start DISABLED, and the AudioContext is only created after the player turns one on
// (a user gesture), so nothing ever autoplays.
import { createKit, METAL_VOICE } from './sound/kit.js';
import { store, setPrefs } from './store.js';

const SFX_TRIM = 2.2;    // level-matches the effects to a comfortable default at the 60% slider position
const MUSIC_TRIM = 1.25; // music sits under the effects at the same slider position

let ctx = null;
let kit = null;
const lastAt = new Map();

function ensure() {
  if (!store.prefs.sound && !store.prefs.music) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (_) { return null; }
    kit = createKit(ctx, { sfxVolume: store.prefs.volume * SFX_TRIM, musicVolume: store.prefs.musicVolume * MUSIC_TRIM });
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// Save battery and avoid sound in a background tab.
document.addEventListener('visibilitychange', () => {
  if (!ctx) return;
  if (document.hidden) { if (ctx.state === 'running') ctx.suspend().catch(() => {}); }
  else if (store.prefs.sound || store.prefs.music) ctx.resume().catch(() => {});
});

export const audio = {
  get enabled() { return !!store.prefs.sound; },
  get musicEnabled() { return !!store.prefs.music; },

  setEnabled(on) {
    setPrefs({ sound: !!on });
    if (on) { ensure(); setTimeout(() => audio.play('click'), 30); }
  },
  setMusic(on) {
    setPrefs({ music: !!on });
    if (on) { if (ensure() && kit) kit.music.start(); }
    else if (kit) kit.music.stop();
  },
  setVolume(v) {
    const vol = Math.min(1, Math.max(0, v));
    setPrefs({ volume: vol });
    if (kit) kit.setSfxVolume(vol * SFX_TRIM);
  },
  setMusicVolume(v) {
    const vol = Math.min(1, Math.max(0, v));
    setPrefs({ musicVolume: vol });
    if (kit) kit.setMusicVolume(vol * MUSIC_TRIM);
  },
  /** Play a named effect. Safe to call anywhere: it does nothing while sound is off. */
  play(name, { duck = false } = {}) {
    if (!store.prefs.sound) return;
    if (store.prefs.cardStyle === 'metal' && METAL_VOICE[name]) name = METAL_VOICE[name];
    const now = performance.now();
    if (now - (lastAt.get(name) || 0) < 35) return; // collapse accidental double triggers
    lastAt.set(name, now);
    try {
      if (!ensure() || !kit) return;
      kit.play(name);
      if (duck) kit.music.duck();
    } catch (_) { /* audio is best-effort */ }
  },
  /** A card hits the table. Metal cards clank (heavier for action and wild cards); printed cards make their sound on release instead. */
  land(card) {
    if (store.prefs.cardStyle !== 'metal') return;
    audio.play(card && card.kind !== 'num' ? 'clang' : 'clank');
  },
};
