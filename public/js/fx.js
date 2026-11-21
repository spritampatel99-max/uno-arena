// Canvas particle effects (confetti, bursts). Fully skipped when reduced motion is on.
import { reducedMotion } from './store.js';

let canvas = null;
let g = null;
let parts = [];
let running = false;
let dpr = 1;

export function initFx(el) {
  canvas = el;
  g = canvas.getContext('2d');
  const resize = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
  };
  resize();
  window.addEventListener('resize', resize);
}

const PALETTE = ['#FF414B', '#287BFF', '#F9D83D', '#27C978', '#ffffff'];

function loop(last) {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  g.clearRect(0, 0, canvas.width, canvas.height);
  parts = parts.filter((p) => p.life > 0 && p.y < window.innerHeight + 60);
  for (const p of parts) {
    p.life -= dt;
    p.vy += p.gravity * dt;
    p.vx *= 1 - p.drag * dt;
    p.vy *= 1 - p.drag * dt * 0.5;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.spin * dt;
    const alpha = Math.max(0, Math.min(1, p.life / p.fade));
    g.save();
    g.globalAlpha = alpha;
    g.translate(p.x * dpr, p.y * dpr);
    g.rotate(p.rot);
    g.fillStyle = p.color;
    if (p.shape === 'circle') { g.beginPath(); g.arc(0, 0, p.size * dpr * 0.5, 0, Math.PI * 2); g.fill(); }
    else g.fillRect((-p.size / 2) * dpr, (-p.size * 0.35) * dpr, p.size * dpr, p.size * 0.7 * dpr);
    g.restore();
  }
  if (parts.length) requestAnimationFrame(() => loop(now));
  else { running = false; g.clearRect(0, 0, canvas.width, canvas.height); }
}

function kick() {
  if (running || !g) return;
  running = true;
  requestAnimationFrame(() => loop(performance.now()));
}

export function confetti({ x = window.innerWidth / 2, y = window.innerHeight * 0.35, count = 120, spread = Math.PI * 2, angle = -Math.PI / 2, power = 620, colors = PALETTE, gravity = 900 } = {}) {
  if (!g || reducedMotion()) return;
  for (let i = 0; i < count; i++) {
    const a = angle + (Math.random() - 0.5) * spread;
    const v = power * (0.35 + Math.random() * 0.65);
    parts.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, gravity, drag: 1.3,
      size: 6 + Math.random() * 7, rot: Math.random() * 6, spin: (Math.random() - 0.5) * 14,
      color: colors[(Math.random() * colors.length) | 0], shape: Math.random() < 0.3 ? 'circle' : 'rect',
      life: 2.4 + Math.random() * 1.4, fade: 0.6,
    });
  }
  kick();
}

export function burst(x, y, color, count = 26) {
  if (!g || reducedMotion()) return;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 120 + Math.random() * 260;
    parts.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, gravity: 260, drag: 2.6,
      size: 4 + Math.random() * 5, rot: 0, spin: 0, color: color || '#fff', shape: 'circle', life: 0.7 + Math.random() * 0.4, fade: 0.4,
    });
  }
  kick();
}

export function celebrate() {
  if (reducedMotion()) return;
  const w = window.innerWidth;
  confetti({ x: w * 0.5, y: window.innerHeight * 0.4, count: 160, power: 760 });
  setTimeout(() => confetti({ x: w * 0.1, y: window.innerHeight * 0.85, count: 90, angle: -Math.PI / 3, spread: 0.9, power: 900 }), 250);
  setTimeout(() => confetti({ x: w * 0.9, y: window.innerHeight * 0.85, count: 90, angle: (-2 * Math.PI) / 3, spread: 0.9, power: 900 }), 450);
}
