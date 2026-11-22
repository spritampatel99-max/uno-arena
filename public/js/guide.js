// "How to play": a short six-step walkthrough using the real card faces. Opens from the welcome screen,
// the lobby, and the sound/settings popover.
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { openModal } from './ui.js';
import { cardEl, backEl } from './cards.js';
import { audio } from './audio.js';

let nextId = 9000;
const C = (color, kind, value = null) => ({ id: nextId++, color, kind, value });

const fan = (cards) => h('div', { class: 'g-fan' }, cards.map((c, i) => h('div', { class: 'g-fan-card', style: { '--i': i, '--n': cards.length } }, cardEl(c, { size: 'guide' }))));

const example = (card, caption, ok) => h('figure', { class: 'g-ex ' + (ok ? 'ok' : 'no') },
  cardEl(card, { size: 'guide' }),
  h('span', { class: 'g-mark', 'aria-hidden': 'true' }, icon(ok ? 'check' : 'x')),
  h('figcaption', {}, caption));

const STEPS = [
  {
    title: 'Empty your hand first',
    body: ['Everyone starts a round with 7 cards. Play them all before anyone else does.', 'On your turn, play one card that matches the top card of the discard pile.'],
    visual: () => fan([C('red', 'num', 7), C('blue', 'skip'), C('green', 'num', 2), C('yellow', 'draw2'), C(null, 'wild')]),
  },
  {
    title: 'Match colour, number or symbol',
    body: ['The top card is the red 7. A red card matches its colour, any 7 matches its number, and a Wild always fits.'],
    visual: () => h('div', { class: 'g-match' },
      h('div', { class: 'g-top' }, cardEl(C('red', 'num', 7), { size: 'big' }), h('span', {}, 'Top card')),
      h('div', { class: 'g-exs' },
        example(C('red', 'num', 3), 'Same colour', true),
        example(C('blue', 'num', 7), 'Same number', true),
        example(C(null, 'wild'), 'Wild fits', true),
        example(C('green', 'num', 4), 'No match', false))),
  },
  {
    title: 'Action cards change the game',
    body: [],
    visual: () => h('ul', { class: 'g-actions' },
      [
        [C('blue', 'skip'), 'Skip', 'The next player misses their turn.'],
        [C('green', 'reverse'), 'Reverse', 'Play changes direction. With two players it works like Skip.'],
        [C('yellow', 'draw2'), 'Draw Two', 'The next player draws 2 cards and misses their turn.'],
        [C(null, 'wild'), 'Wild', 'Play it any time and choose the next colour.'],
        [C(null, 'wild4'), 'Wild Draw Four', 'Choose a colour; the next player draws 4. Only allowed when you hold no card of the current colour.'],
      ].map(([card, name, text]) => h('li', {}, cardEl(card, { size: 'guide' }), h('div', {}, h('b', {}, name), h('span', {}, text))))),
  },
  {
    title: 'Nothing to play? Draw',
    body: ['Tap the draw pile to take one card. If you can play it, you may, but only that card. Otherwise pass.', 'Each turn has a timer. If it runs out, the game draws for you.'],
    visual: () => h('div', { class: 'g-draw' }, h('div', { class: 'g-stack' }, backEl({ size: 'guide' }), backEl({ size: 'guide' }), backEl({ size: 'guide' })),
      h('span', { class: 'g-arrow', 'aria-hidden': 'true' }, icon('arrowRight', { size: 36 })), cardEl(C('yellow', 'num', 5), { size: 'big' })),
  },
  {
    title: 'Say UNO!',
    body: ['Down to one card? Press UNO before you play it. If you forget, any player can press Catch UNO within 4 seconds, and you draw 2 cards.'],
    visual: () => h('div', { class: 'g-uno' }, cardEl(C('green', 'num', 9), { size: 'big' }), h('span', { class: 'uno-pill big' }, 'UNO!')),
  },
  {
    title: 'Scoring and winning',
    body: ['The round winner scores every card left in the other hands. First to the winning score (500 by default) wins the match.', 'Before the game, the host can turn on house rules: stacking, jump-in and draw until playable.'],
    visual: () => h('div', { class: 'g-score' },
      h('div', {}, h('b', {}, '0 – 9'), h('span', {}, 'Face value')),
      h('div', {}, h('b', {}, '20'), h('span', {}, 'Skip, Reverse, Draw Two')),
      h('div', {}, h('b', {}, '50'), h('span', {}, 'Wild, Wild Draw Four'))),
  },
];

export function openGuide() {
  let i = 0;
  const stage = h('div', { class: 'g-stage' });
  const dots = h('div', { class: 'g-dots', role: 'tablist', 'aria-label': 'Steps' });
  const title = h('h2', { class: 'g-title', 'aria-live': 'polite' });
  const back = h('button', { class: 'btn ghost', onclick: () => go(i - 1) }, icon('chevronLeft'), 'Back');
  const next = h('button', { class: 'btn', 'data-autofocus': '', onclick: () => (i === STEPS.length - 1 ? modal.close() : go(i + 1)) });

  function go(to) {
    i = Math.max(0, Math.min(STEPS.length - 1, to));
    const st = STEPS[i];
    title.textContent = st.title;
    clear(stage);
    stage.append(h('div', { class: 'g-step' }, st.visual(), st.body.length ? h('div', { class: 'g-text' }, st.body.map((t) => h('p', {}, t))) : null));
    clear(dots);
    STEPS.forEach((_, k) => dots.append(h('button', { class: 'g-dot' + (k === i ? ' on' : ''), role: 'tab', 'aria-selected': String(k === i), 'aria-label': `Step ${k + 1} of ${STEPS.length}`, onclick: () => go(k) })));
    back.disabled = i === 0;
    clear(next);
    if (i === STEPS.length - 1) next.append('Got it');
    else next.append('Next', icon('chevronRight'));
    audio.play('flick');
  }

  const modal = openModal(h('div', { class: 'guide' },
    h('header', { class: 'set-head' }, h('div', {}, h('div', { class: 'g-kicker' }, 'How to play'), title),
      h('button', { class: 'icon-btn', 'aria-label': 'Close guide', onclick: () => modal.close() }, icon('x'))),
    stage,
    h('footer', { class: 'g-foot' }, back, dots, next)),
  { wide: true, label: 'How to play' });
  modal.el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1); }
  });
  go(0);
  return modal;
}
