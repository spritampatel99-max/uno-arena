// Original avatar set (6 animals + bot) and the UNO ARENA logo, drawn as inline SVG — no remote images.
import { fromHTML, h } from './dom.js';

export const AVATAR_IDS = ['fox', 'bunny', 'panda', 'cat', 'penguin', 'dragon'];
export const AVATAR_LABEL = { fox: 'Fox', bunny: 'Bunny', panda: 'Panda', cat: 'Cat', penguin: 'Penguin', dragon: 'Dragon', bot: 'Bot' };

const BG = {
  fox: ['#ff9a5a', '#ff5b4d'], bunny: ['#ffb3d1', '#c98cff'], panda: ['#7fe3b5', '#27a8c9'],
  cat: ['#ffe27a', '#ff9f43'], penguin: ['#7cb8ff', '#4b5cff'], dragon: ['#6ee89f', '#1fa56b'], bot: ['#3a4c72', '#202b43'],
};

const ART = {
  fox: `
    <path d="M12 14 L24 26 L14 40Z" fill="#e8591f"/><path d="M52 14 L40 26 L50 40Z" fill="#e8591f"/>
    <path d="M15 17 L23 25 L16 34Z" fill="#2b1a17"/><path d="M49 17 L41 25 L48 34Z" fill="#2b1a17"/>
    <path d="M10 36 Q10 22 32 22 Q54 22 54 36 Q54 56 32 58 Q10 56 10 36Z" fill="#ff7a2f"/>
    <path d="M10 38 Q22 40 32 52 Q42 40 54 38 Q52 56 32 58 Q12 56 10 38Z" fill="#fff4e8"/>
    <ellipse cx="23" cy="36" rx="3" ry="3.6" fill="#1c1210"/><ellipse cx="41" cy="36" rx="3" ry="3.6" fill="#1c1210"/>
    <circle cx="24" cy="35" r="1" fill="#fff"/><circle cx="42" cy="35" r="1" fill="#fff"/>
    <path d="M28.5 46 Q32 49.5 35.5 46 Q32 43.5 28.5 46Z" fill="#1c1210"/>`,
  bunny: `
    <ellipse cx="22" cy="14" rx="6" ry="15" fill="#fff"/><ellipse cx="42" cy="14" rx="6" ry="15" fill="#fff"/>
    <ellipse cx="22" cy="15" rx="2.8" ry="10" fill="#ff9dc2"/><ellipse cx="42" cy="15" rx="2.8" ry="10" fill="#ff9dc2"/>
    <ellipse cx="32" cy="41" rx="21" ry="18.5" fill="#fff"/>
    <ellipse cx="24" cy="39" rx="2.8" ry="3.4" fill="#27213a"/><ellipse cx="40" cy="39" rx="2.8" ry="3.4" fill="#27213a"/>
    <circle cx="25" cy="38" r=".9" fill="#fff"/><circle cx="41" cy="38" r=".9" fill="#fff"/>
    <ellipse cx="19" cy="46" rx="4" ry="2.6" fill="#ffb3cd" opacity=".8"/><ellipse cx="45" cy="46" rx="4" ry="2.6" fill="#ffb3cd" opacity=".8"/>
    <path d="M29.5 44 Q32 47 34.5 44 Q32 42 29.5 44Z" fill="#ff7aa8"/>`,
  panda: `
    <circle cx="15" cy="17" r="8" fill="#1d2230"/><circle cx="49" cy="17" r="8" fill="#1d2230"/>
    <ellipse cx="32" cy="38" rx="22" ry="20" fill="#fff"/>
    <ellipse cx="23" cy="35" rx="6.4" ry="7.6" fill="#1d2230" transform="rotate(18 23 35)"/><ellipse cx="41" cy="35" rx="6.4" ry="7.6" fill="#1d2230" transform="rotate(-18 41 35)"/>
    <circle cx="24" cy="35" r="2.2" fill="#fff"/><circle cx="40" cy="35" r="2.2" fill="#fff"/>
    <circle cx="24.4" cy="35.2" r="1" fill="#1d2230"/><circle cx="39.6" cy="35.2" r="1" fill="#1d2230"/>
    <ellipse cx="32" cy="44" rx="4" ry="3" fill="#1d2230"/><path d="M27 49 Q32 53 37 49" stroke="#1d2230" stroke-width="1.8" fill="none" stroke-linecap="round"/>`,
  cat: `
    <path d="M11 12 L26 24 L12 40Z" fill="#6c7a99"/><path d="M53 12 L38 24 L52 40Z" fill="#6c7a99"/>
    <path d="M14 18 L23 25 L15 33Z" fill="#ffb3c7"/><path d="M50 18 L41 25 L49 33Z" fill="#ffb3c7"/>
    <path d="M9 38 Q9 22 32 22 Q55 22 55 38 Q55 58 32 58 Q9 58 9 38Z" fill="#8795b3"/>
    <path d="M32 22 L32 29 M24 24 L26 30 M40 24 L38 30" stroke="#5c6b8c" stroke-width="2.4" stroke-linecap="round"/>
    <ellipse cx="23" cy="38" rx="3.4" ry="4" fill="#ffe27a"/><ellipse cx="41" cy="38" rx="3.4" ry="4" fill="#ffe27a"/>
    <ellipse cx="23" cy="38" rx="1.2" ry="3.2" fill="#1c2233"/><ellipse cx="41" cy="38" rx="1.2" ry="3.2" fill="#1c2233"/>
    <path d="M29.5 45 L34.5 45 L32 48Z" fill="#ff8fb0"/>
    <path d="M32 48 Q28 52 25 50 M32 48 Q36 52 39 50" stroke="#2b3550" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    <path d="M6 44 L19 46 M6 50 L19 49 M58 44 L45 46 M58 50 L45 49" stroke="#dfe6f5" stroke-width="1.4" stroke-linecap="round"/>`,
  penguin: `
    <ellipse cx="32" cy="38" rx="21" ry="23" fill="#1f2740"/>
    <path d="M32 24 Q18 24 17 40 Q17 56 32 57 Q47 56 47 40 Q46 24 32 24Z" fill="#f6f8ff"/>
    <path d="M15 40 Q9 34 11 26 Q17 30 18 38Z" fill="#161c30"/><path d="M49 40 Q55 34 53 26 Q47 30 46 38Z" fill="#161c30"/>
    <circle cx="25.5" cy="33" r="3.6" fill="#fff"/><circle cx="38.5" cy="33" r="3.6" fill="#fff"/>
    <circle cx="26" cy="33.4" r="1.7" fill="#101525"/><circle cx="38" cy="33.4" r="1.7" fill="#101525"/>
    <path d="M27 39 L37 39 L32 46Z" fill="#ffab2e"/><path d="M27 39 L37 39 L32 41.6Z" fill="#ffc861"/>`,
  dragon: `
    <path d="M17 20 L12 5 L26 15Z" fill="#ffe27a"/><path d="M47 20 L52 5 L38 15Z" fill="#ffe27a"/>
    <path d="M8 38 Q8 20 32 20 Q56 20 56 38 Q56 58 32 58 Q8 58 8 38Z" fill="#2fcf80"/>
    <path d="M32 20 Q36 14 40 17 Q36 18 35 22Z M26 21 Q24 15 20 16 Q23 18 23 22Z" fill="#1ba868"/>
    <ellipse cx="32" cy="48" rx="13" ry="9" fill="#a6f0c8"/>
    <ellipse cx="22.5" cy="35" rx="4" ry="4.4" fill="#fff6c0"/><ellipse cx="41.5" cy="35" rx="4" ry="4.4" fill="#fff6c0"/>
    <ellipse cx="22.8" cy="35" rx="1.3" ry="3.5" fill="#1a2b1f"/><ellipse cx="41.2" cy="35" rx="1.3" ry="3.5" fill="#1a2b1f"/>
    <circle cx="28" cy="47" r="1.4" fill="#168a57"/><circle cx="36" cy="47" r="1.4" fill="#168a57"/>
    <path d="M26 52 Q32 56 38 52" stroke="#168a57" stroke-width="1.8" fill="none" stroke-linecap="round"/>`,
  bot: `
    <path d="M32 9 L32 17" stroke="#9fb3d9" stroke-width="3" stroke-linecap="round"/><circle cx="32" cy="8" r="3.4" fill="#ff414b"/>
    <rect x="12" y="17" width="40" height="34" rx="11" fill="#5d7099"/><rect x="12" y="17" width="40" height="34" rx="11" fill="url(#botShine)" opacity=".4"/>
    <rect x="17" y="25" width="30" height="17" rx="8" fill="#0d1322"/>
    <circle cx="25" cy="33.5" r="4" fill="#27c978"/><circle cx="39" cy="33.5" r="4" fill="#27c978"/>
    <circle cx="26" cy="32.4" r="1.2" fill="#d6ffe9"/><circle cx="40" cy="32.4" r="1.2" fill="#d6ffe9"/>
    <path d="M26 46.5 L38 46.5" stroke="#202b43" stroke-width="2.4" stroke-linecap="round"/>
    <rect x="7" y="29" width="5" height="12" rx="2.5" fill="#9fb3d9"/><rect x="52" y="29" width="5" height="12" rx="2.5" fill="#9fb3d9"/>`,
};

let uid = 0;
export function avatarSVG(id) {
  const key = ART[id] ? id : 'bot';
  const [c1, c2] = BG[key];
  const g = `avg${++uid}`;
  return fromHTML(`<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
    <linearGradient id="botShine" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
    <rect width="64" height="64" fill="url(#${g})"/>${ART[key]}</svg>`);
}

// Cosmetic rings (the server keeps the same list; see FRAMES in server/rooms.js).
export const FRAME_IDS = ['steel', 'gilded', 'prism', 'neon'];
export const FRAME_LABEL = { steel: 'Brushed steel', gilded: 'Gilded', prism: 'Prism', neon: 'Neon' };

export function avatar(id, size = 48, extraClass = '', frame = 'steel') {
  const f = FRAME_IDS.includes(frame) ? frame : 'steel';
  const fw = Math.max(2, Math.round(size * 0.065 * 10) / 10);
  return h('span', { class: 'avatar ' + extraClass, dataset: { frame: f }, style: { width: `calc(${size}px * var(--s))`, height: `calc(${size}px * var(--s))`, '--fw': `calc(${fw}px * var(--s))` } }, avatarSVG(id));
}

/** UNO ARENA mark: a tilted card with a four-colour ring. */
export function logoMark() {
  return fromHTML(`<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs><linearGradient id="lgR" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff6a73"/><stop offset="1" stop-color="#e02a37"/></linearGradient></defs>
    <rect x="9" y="3.5" width="30" height="41" rx="7" transform="rotate(10 24 24)" fill="url(#lgR)"/>
    <rect x="9" y="3.5" width="30" height="41" rx="7" transform="rotate(10 24 24)" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="2"/>
    <ellipse cx="24" cy="24" rx="9.5" ry="14.5" transform="rotate(34 24 24)" fill="#fff"/>
    <path d="M24 12 A12 12 0 0 1 36 24 L24 24Z" fill="#f9d83d"/><path d="M36 24 A12 12 0 0 1 24 36 L24 24Z" fill="#287bff"/>
    <path d="M24 36 A12 12 0 0 1 12 24 L24 24Z" fill="#27c978"/><path d="M12 24 A12 12 0 0 1 24 12 L24 24Z" fill="#ff414b"/>
    <circle cx="24" cy="24" r="12" fill="none" stroke="#fff" stroke-width="2.2"/></svg>`);
}
