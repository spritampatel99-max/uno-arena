// Appearance options. Pure data so the store, the settings panel and CSS all agree on the ids.
export const THEMES = [
  { id: 'midnight', name: 'Midnight', note: 'The original arena', swatch: ['#2a3d6b', '#0e1428'] },
  { id: 'emerald', name: 'Emerald', note: 'Classic card-room green', swatch: ['#1f6b4c', '#0b2219'] },
  { id: 'crimson', name: 'Crimson', note: 'Velvet and wine', swatch: ['#6b2338', '#1c0910'] },
  { id: 'aurora', name: 'Aurora', note: 'Northern-lights violet', swatch: ['#42388a', '#0f1030'] },
];

export const CARD_BACKS = [
  { id: 'classic', name: 'Classic' },
  { id: 'gilded', name: 'Gilded' },
  { id: 'neon', name: 'Neon grid' },
  { id: 'mono', name: 'Mono' },
];

export const CARD_STYLES = [
  { id: 'metal', name: 'Metal', note: 'Brushed steel plates that clank' },
  { id: 'classic', name: 'Classic', note: 'Printed cards that snap' },
];

export const THEME_IDS = THEMES.map((t) => t.id);
export const BACK_IDS = CARD_BACKS.map((b) => b.id);
export const STYLE_IDS = CARD_STYLES.map((c) => c.id);
