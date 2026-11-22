// Turns the QR generator into DOM and into a downloadable file. Kept apart from qr.js so that module stays pure.
import { makeQr, qrSvg } from './qr.js';

/** An <svg> element for the text. The markup comes from our own generator (numbers only), never from player input. */
export function qrElement(text, { label = 'QR code', ecl = 'M' } = {}) {
  const svg = qrSvg(makeQr(text, ecl), { label });
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const node = document.importNode(doc.documentElement, true);
  node.setAttribute('class', 'qr-svg');
  return node;
}

/** Saves the QR code as a crisp SVG file. */
export function downloadQr(text, filename = 'uno-arena-invite.svg') {
  const svg = qrSvg(makeQr(text, 'M'), { label: 'UNO ARENA invitation' });
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export const isLocalOnly = () => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
