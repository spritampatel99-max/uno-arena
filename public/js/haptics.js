// Short vibration cues for phones. Does nothing where the Vibration API is missing (desktop, iOS Safari)
// or when the player switched vibration off in Settings.
import { store } from './store.js';

const PATTERNS = {
  tap: 8,
  play: 12,
  turn: [18, 50, 18],
  penalty: [70, 40, 70],
  uno: [18, 30, 18, 30, 40],
  win: [30, 40, 30, 40, 90],
  error: [40, 40, 40],
};

export const hapticsSupported = () => typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

export function haptic(kind) {
  if (!store.prefs.haptics || !hapticsSupported()) return;
  try { navigator.vibrate(PATTERNS[kind] || 10); } catch (_) { /* best effort */ }
}
