// Move hints. Pure functions with no imports, so they can be unit-tested in Node.
// The server decides which cards are legal (`playable`); this only ranks those legal cards.
// It is advice for the player who switched hints on in Settings, never a rule.

export const COLORS = ['red', 'blue', 'yellow', 'green'];

export function cardPoints(c) {
  if (c.kind === 'num') return c.value;
  if (c.kind === 'wild' || c.kind === 'wild4') return 50;
  return 20;
}

const isWild = (c) => c.kind === 'wild' || c.kind === 'wild4';
const isAttack = (c) => c.kind === 'draw2' || c.kind === 'wild4' || c.kind === 'skip';

/** The colour to name after a Wild: the one the player holds most of (ties keep the colour order). */
export function suggestColor(hand, exceptId = null) {
  const count = Object.fromEntries(COLORS.map((c) => [c, 0]));
  for (const c of hand) if (c.color && c.id !== exceptId) count[c.color] += 1;
  return COLORS.slice().sort((a, b) => count[b] - count[a])[0];
}

/**
 * @param {{ hand: object[], playable: number[], opponents: {name: string, cards: number}[] }} input
 * @returns {{ id: number, reason: string } | null}
 */
export function suggestPlay({ hand, playable, opponents = [] }) {
  const ok = hand.filter((c) => playable.includes(c.id));
  if (!ok.length) return null;
  if (ok.length === 1) return { id: ok[0].id, reason: 'Your only playable card' };

  const threat = opponents.filter((o) => o.cards <= 2).sort((a, b) => a.cards - b.cards)[0] || null;
  const holds = (color, id) => hand.filter((c) => c.color === color && c.id !== id).length;

  const scored = ok.map((c) => {
    let score = cardPoints(c);                       // shed high-value cards first: they cost the most if someone else wins
    if (isWild(c)) score -= threat ? 0 : 70;         // a Wild is the best card to keep, unless someone is about to go out
    if (threat && isAttack(c)) score += 45;          // make the player who is nearly out draw or miss a turn
    if (c.color) score += holds(c.color, c.id) * 3;  // lean towards the colour you hold most, so you keep options
    return { c, score };
  }).sort((a, b) => b.score - a.score || a.c.id - b.c.id);

  const best = scored[0].c;
  let reason;
  if (threat && isAttack(best)) reason = `Slows down ${threat.name}, who has ${threat.cards === 1 ? 'one card' : 'two cards'} left`;
  else if (isWild(best)) reason = 'A Wild is your best move here. Name the colour you hold most';
  else if (cardPoints(best) >= 20) reason = 'Gets rid of a high-value card';
  else reason = 'Keeps your best colour in hand';
  return { id: best.id, reason };
}
