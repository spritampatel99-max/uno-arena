'use strict';
/**
 * UNO ARENA — authoritative game engine.
 *
 * Pure game logic: no I/O, no timers. Every mutation takes the current time
 * (`now`, ms) so timing rules (turn timer, UNO catch window) are decided by the
 * server clock only. Every action returns `{ ok: true, events }` or
 * `{ ok: false, error }`; nothing is trusted from the client.
 *
 * RULES IMPLEMENTED (official unless marked HOUSE)
 *  - 108-card deck: 0-9 / Skip / Reverse / Draw Two in 4 colours, 4 Wild, 4 Wild Draw Four.
 *  - Match: colour or number/symbol; Wild always playable.
 *  - Wild Draw Four only when the hand holds no card of the active colour. The server
 *    refuses illegal plays outright instead of using the challenge procedure (HOUSE).
 *  - Skip / Reverse (acts as Skip with 2 players) / Draw Two (victim draws 2, loses turn)
 *    / Wild Draw Four (victim draws 4, loses turn).
 *  - Drawing: one card; if it is playable it may be played (and only that card), otherwise
 *    the turn ends. Setting `drawUntilPlayable` keeps drawing until a playable card appears.
 *  - Starting card: a Wild/Wild Draw Four is shuffled back and a new card turned (HOUSE).
 *    Skip / Reverse / Draw Two as the first card apply to the first player.
 *  - Round scoring: winner scores the sum of opponents' cards (number = face, Skip/Reverse/
 *    Draw Two = 20, Wild/Wild Draw Four = 50). A last Draw card is still dealt to the victim
 *    before scoring. First to `winningScore` wins the match.
 *  - UNO: call it while holding 2 cards (armed) or 1 card. Reaching 1 card without calling
 *    opens a 4 s catch window; a successful catch costs 2 cards (HOUSE window length).
 *  - Optional rules (off by default, all enforced here): `stacking` (Draw Two on Draw Two,
 *    Wild Draw Four on Wild Draw Four only — HOUSE), `jumpIn` (an identical coloured card
 *    may be played out of turn — HOUSE), `drawUntilPlayable` (HOUSE).
 */

const COLORS = ['red', 'blue', 'yellow', 'green'];
const UNO_CATCH_WINDOW_MS = 4000;
const UNO_PENALTY_CARDS = 2;

const DEFAULT_SETTINGS = Object.freeze({
  maxPlayers: 4,
  startingCards: 7,
  winningScore: 500,
  turnSeconds: 30,
  stacking: false,
  jumpIn: false,
  drawUntilPlayable: false,
});

const SETTING_OPTIONS = Object.freeze({
  maxPlayers: [2, 3, 4],
  startingCards: [5, 7, 10],
  winningScore: [100, 200, 300, 500, 1000],
  turnSeconds: [15, 20, 30, 45, 60, 90],
});

/** Validate a partial settings object against the supported options. */
function sanitizeSettings(input, base = DEFAULT_SETTINGS) {
  const next = { ...base };
  if (input == null || typeof input !== 'object') return { ok: false, error: 'BAD_SETTINGS' };
  for (const [key, value] of Object.entries(input)) {
    if (key in SETTING_OPTIONS) {
      if (!SETTING_OPTIONS[key].includes(value)) return { ok: false, error: 'BAD_SETTINGS' };
      next[key] = value;
    } else if (key === 'stacking' || key === 'jumpIn' || key === 'drawUntilPlayable') {
      if (typeof value !== 'boolean') return { ok: false, error: 'BAD_SETTINGS' };
      next[key] = value;
    } else {
      return { ok: false, error: 'BAD_SETTINGS' };
    }
  }
  return { ok: true, settings: next };
}

// ---------------------------------------------------------------- deck

function buildDeck() {
  const cards = [];
  let id = 0;
  for (const color of COLORS) {
    cards.push({ id: id++, color, kind: 'num', value: 0 });
    for (let v = 1; v <= 9; v++) {
      cards.push({ id: id++, color, kind: 'num', value: v });
      cards.push({ id: id++, color, kind: 'num', value: v });
    }
    for (const kind of ['skip', 'reverse', 'draw2']) {
      cards.push({ id: id++, color, kind, value: null });
      cards.push({ id: id++, color, kind, value: null });
    }
  }
  for (let i = 0; i < 4; i++) cards.push({ id: id++, color: null, kind: 'wild', value: null });
  for (let i = 0; i < 4; i++) cards.push({ id: id++, color: null, kind: 'wild4', value: null });
  return cards.map(Object.freeze);
}

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cardLabel(c) {
  const col = c.color ? c.color[0].toUpperCase() + c.color.slice(1) + ' ' : '';
  switch (c.kind) {
    case 'num': return col + c.value;
    case 'skip': return col + 'Skip';
    case 'reverse': return col + 'Reverse';
    case 'draw2': return col + 'Draw Two';
    case 'wild': return 'Wild';
    case 'wild4': return 'Wild Draw Four';
    default: return '?';
  }
}

function cardPoints(c) {
  if (c.kind === 'num') return c.value;
  if (c.kind === 'wild' || c.kind === 'wild4') return 50;
  return 20;
}

// ---------------------------------------------------------------- match lifecycle

function createMatch({ playerIds, settings, rng = Math.random, now = Date.now() }) {
  const m = {
    settings: { ...settings },
    rng,
    seats: [...playerIds], // everyone who started the match (for the scoreboard)
    order: [...playerIds], // active players, in turn order (clockwise)
    scores: {},
    stats: {},
    round: 0,
    dealerIdx: Math.floor(rng() * playerIds.length),
    deck: [],
    discard: [],
    hands: {},
    turnIdx: 0,
    dir: 1, // +1 clockwise, -1 counter-clockwise
    activeColor: null,
    pending: null, // { kind: 'draw2' | 'draw4', amount } — only with stacking
    drawn: null, // { pid, cardId } — card drawn this turn (the only playable one)
    uno: {},
    turnSeq: 0,
    turnEndsAt: 0,
    phase: 'idle', // idle | playing | round_over | finished
    roundResult: null,
    winnerId: null,
    history: [],
    startedAt: now,
    endedAt: null,
    endReason: null,
  };
  for (const pid of playerIds) {
    m.scores[pid] = 0;
    m.stats[pid] = { played: 0, drawn: 0, special: 0, unos: 0, penalties: 0 };
  }
  return m;
}

const nextIdx = (m, from, steps = 1) => {
  const n = m.order.length;
  return (((from + m.dir * steps) % n) + n) % n;
};
const currentId = (m) => m.order[m.turnIdx];
const topCard = (m) => m.discard[m.discard.length - 1];
const fail = (error) => ({ ok: false, error });

function beginTurn(m, now, events) {
  m.turnSeq += 1;
  m.drawn = null;
  m.turnEndsAt = now + m.settings.turnSeconds * 1000;
  if (events) events.push({ type: 'turn', pid: currentId(m) });
}

function advanceTurn(m, steps, now, events) {
  m.turnIdx = nextIdx(m, m.turnIdx, steps);
  beginTurn(m, now, events);
}

function reshuffle(m, events) {
  if (m.discard.length <= 1) return false;
  const top = m.discard.pop();
  m.deck = shuffle(m.discard, m.rng);
  m.discard = [top];
  events.push({ type: 'reshuffle', count: m.deck.length });
  return true;
}

/** Move cards from the deck into a hand (no event). Handles reshuffling. */
function takeCards(m, pid, count, events) {
  const got = [];
  for (let i = 0; i < count; i++) {
    if (m.deck.length === 0 && !reshuffle(m, events)) break;
    const c = m.deck.pop();
    m.hands[pid].push(c);
    got.push(c);
  }
  if (got.length) {
    m.stats[pid].drawn += got.length;
    m.uno[pid] = { called: false, vulnerableUntil: 0 };
  }
  return got;
}

function drawCards(m, pid, count, reason, events) {
  const got = takeCards(m, pid, count, events);
  if (got.length) events.push({ type: 'draw', pid, count: got.length, cards: got, reason });
  return got;
}

function startRound(m, now) {
  const events = [];
  m.round += 1;
  m.deck = shuffle(buildDeck(), m.rng);
  m.discard = [];
  m.pending = null;
  m.drawn = null;
  m.dir = 1;
  m.roundResult = null;
  m.phase = 'playing';
  if (m.round > 1) m.dealerIdx = (m.dealerIdx + 1) % m.order.length;
  m.dealerIdx %= m.order.length;
  const n = m.order.length;
  for (const pid of m.order) {
    m.hands[pid] = [];
    m.uno[pid] = { called: false, vulnerableUntil: 0 };
  }
  for (let i = 0; i < m.settings.startingCards; i++) {
    for (const pid of m.order) m.hands[pid].push(m.deck.pop());
  }
  // turn a starting card; Wild / Wild Draw Four are put back (HOUSE simplification)
  let start = m.deck.pop();
  while (start.kind === 'wild' || start.kind === 'wild4') {
    m.deck.splice(Math.floor(m.rng() * (m.deck.length + 1)), 0, start);
    start = m.deck.pop();
  }
  m.discard.push(start);
  m.activeColor = start.color;
  const dealerId = m.order[m.dealerIdx];
  events.push({ type: 'round_start', round: m.round, dealerId, card: start });

  m.turnIdx = (m.dealerIdx + 1) % n;
  if (start.kind === 'skip') {
    events.push({ type: 'skip', pid: m.order[m.turnIdx] });
    m.turnIdx = (m.dealerIdx + 2) % n;
  } else if (start.kind === 'reverse') {
    m.dir = -1;
    events.push({ type: 'reverse', dir: m.dir });
    m.turnIdx = m.dealerIdx; // dealer starts, play runs counter-clockwise
  } else if (start.kind === 'draw2') {
    const victim = m.order[m.turnIdx];
    drawCards(m, victim, 2, 'penalty', events);
    events.push({ type: 'skip', pid: victim });
    m.turnIdx = (m.dealerIdx + 2) % n;
  }
  beginTurn(m, now, events);
  return events;
}

// ---------------------------------------------------------------- legality

function cardMatches(m, hand, card) {
  if (card.kind === 'wild') return true;
  if (card.kind === 'wild4') return !hand.some((c) => c.color && c.color === m.activeColor);
  if (card.color === m.activeColor) return true;
  const top = topCard(m);
  if (!top || top.kind === 'wild' || top.kind === 'wild4') return false;
  if (card.kind !== top.kind) return false;
  return card.kind !== 'num' || card.value === top.value;
}

function isPlayable(m, pid, card) {
  if (m.phase !== 'playing' || currentId(m) !== pid) return false;
  if (m.drawn && m.drawn.pid === pid && m.drawn.cardId !== card.id) return false;
  if (m.pending) {
    return (m.pending.kind === 'draw2' && card.kind === 'draw2') ||
           (m.pending.kind === 'draw4' && card.kind === 'wild4');
  }
  return cardMatches(m, m.hands[pid], card);
}

function playableIds(m, pid) {
  if (m.phase !== 'playing' || currentId(m) !== pid) return [];
  return m.hands[pid].filter((c) => isPlayable(m, pid, c)).map((c) => c.id);
}

function canJumpIn(m, pid, card) {
  if (!m.settings.jumpIn || m.phase !== 'playing') return false;
  if (currentId(m) === pid || m.pending) return false;
  const top = topCard(m);
  if (!top || !top.color || !card.color) return false;
  return card.color === top.color && card.kind === top.kind &&
         (card.kind !== 'num' || card.value === top.value);
}

function jumpInIds(m, pid) {
  if (!m.settings.jumpIn || m.phase !== 'playing' || !m.hands[pid]) return [];
  return m.hands[pid].filter((c) => canJumpIn(m, pid, c)).map((c) => c.id);
}

function canDraw(m, pid) {
  return m.phase === 'playing' && currentId(m) === pid && !m.drawn;
}
function canPass(m, pid) {
  return m.phase === 'playing' && currentId(m) === pid && !!m.drawn && m.drawn.pid === pid && !m.pending;
}

// ---------------------------------------------------------------- actions

function guardTurn(m, pid) {
  if (m.phase !== 'playing') return fail('NOT_PLAYING');
  if (!m.hands[pid]) return fail('NOT_IN_GAME');
  if (currentId(m) !== pid) return fail('NOT_YOUR_TURN');
  return null;
}

function playCard(m, pid, cardId, chosenColor, now) {
  if (m.phase !== 'playing') return fail('NOT_PLAYING');
  const hand = m.hands[pid];
  if (!hand) return fail('NOT_IN_GAME');
  const card = hand.find((c) => c.id === cardId);
  if (!card) return fail('NOT_IN_HAND');

  const isCurrent = currentId(m) === pid;
  let jump = false;
  if (isCurrent) {
    if (!isPlayable(m, pid, card)) {
      if (m.pending) return fail('MUST_STACK_OR_DRAW');
      if (m.drawn && m.drawn.cardId !== card.id) return fail('ONLY_DRAWN_CARD');
      if (card.kind === 'wild4' && !hand.every((c) => c.id === card.id || !c.color || c.color !== m.activeColor)) {
        return fail('WILD4_ILLEGAL');
      }
      return fail('ILLEGAL_MOVE');
    }
  } else if (canJumpIn(m, pid, card)) {
    jump = true;
  } else {
    return fail('NOT_YOUR_TURN');
  }
  const isWild = card.kind === 'wild' || card.kind === 'wild4';
  if (isWild && !COLORS.includes(chosenColor)) return fail('COLOR_REQUIRED');

  const events = [];
  hand.splice(hand.indexOf(card), 1);
  m.discard.push(card);
  m.activeColor = isWild ? chosenColor : card.color;
  m.stats[pid].played += 1;
  if (card.kind !== 'num') m.stats[pid].special += 1;
  events.push({ type: 'play', pid, card, color: m.activeColor, jumpIn: jump });
  if (isWild) events.push({ type: 'color', color: m.activeColor, pid });

  if (jump) m.turnIdx = m.order.indexOf(pid);
  m.drawn = null;

  const base = card.kind === 'draw2' ? 2 : card.kind === 'wild4' ? 4 : 0;
  const finalPlay = hand.length === 0;

  if (finalPlay) m.uno[pid] = { called: false, vulnerableUntil: 0 };
  else if (hand.length === 1) {
    if (m.uno[pid].called) {
      m.stats[pid].unos += 1;
      events.push({ type: 'uno', pid });
    } else {
      m.uno[pid].vulnerableUntil = now + UNO_CATCH_WINDOW_MS;
      events.push({ type: 'one_card', pid, until: m.uno[pid].vulnerableUntil });
    }
  } else {
    m.uno[pid] = { called: false, vulnerableUntil: 0 };
  }

  // ---- card effects
  switch (card.kind) {
    case 'num':
    case 'wild':
      if (!finalPlay) advanceTurn(m, 1, now, events);
      break;
    case 'skip': {
      events.push({ type: 'skip', pid: m.order[nextIdx(m, m.turnIdx, 1)] });
      if (!finalPlay) advanceTurn(m, 2, now, events);
      break;
    }
    case 'reverse': {
      m.dir *= -1;
      events.push({ type: 'reverse', dir: m.dir });
      if (m.order.length === 2) {
        events.push({ type: 'skip', pid: m.order[nextIdx(m, m.turnIdx, 1)] });
        if (!finalPlay) advanceTurn(m, 2, now, events);
      } else if (!finalPlay) advanceTurn(m, 1, now, events);
      break;
    }
    case 'draw2':
    case 'wild4': {
      const kind = card.kind === 'draw2' ? 'draw2' : 'draw4';
      if (m.settings.stacking && !finalPlay) {
        m.pending = { kind, amount: (m.pending ? m.pending.amount : 0) + base };
        events.push({ type: 'pending', kind, amount: m.pending.amount });
        advanceTurn(m, 1, now, events);
      } else {
        const amount = base + (m.pending ? m.pending.amount : 0);
        m.pending = null;
        const victim = m.order[nextIdx(m, m.turnIdx, 1)];
        drawCards(m, victim, amount, 'penalty', events);
        events.push({ type: 'skip', pid: victim });
        if (!finalPlay) advanceTurn(m, 2, now, events);
      }
      break;
    }
    default:
      break;
  }

  if (finalPlay) endRound(m, pid, now, events);
  return { ok: true, events };
}

function drawAction(m, pid, now) {
  const err = guardTurn(m, pid);
  if (err) return err;
  const events = [];
  if (m.pending) {
    const amount = m.pending.amount;
    m.pending = null;
    drawCards(m, pid, amount, 'penalty', events);
    events.push({ type: 'skip', pid });
    advanceTurn(m, 1, now, events);
    return { ok: true, events };
  }
  if (m.drawn) return fail('ALREADY_DRAWN');

  let got = [];
  if (m.settings.drawUntilPlayable) {
    for (;;) {
      const one = takeCards(m, pid, 1, events);
      if (!one.length) break;
      got.push(one[0]);
      if (cardMatches(m, m.hands[pid], one[0])) break;
    }
  } else {
    got = takeCards(m, pid, 1, events);
  }
  if (got.length) events.push({ type: 'draw', pid, count: got.length, cards: got, reason: 'draw' });
  const last = got[got.length - 1];
  if (last && cardMatches(m, m.hands[pid], last)) {
    m.drawn = { pid, cardId: last.id };
  } else {
    events.push({ type: 'pass', pid, auto: true });
    advanceTurn(m, 1, now, events);
  }
  return { ok: true, events };
}

function passAction(m, pid, now) {
  const err = guardTurn(m, pid);
  if (err) return err;
  if (!canPass(m, pid)) return fail('CANNOT_PASS');
  const events = [{ type: 'pass', pid, auto: false }];
  advanceTurn(m, 1, now, events);
  return { ok: true, events };
}

/** Turn timer expired: apply the automatic action (draw / take penalty / pass). */
function timeoutTurn(m, pid, now) {
  const err = guardTurn(m, pid);
  if (err) return err;
  const events = [{ type: 'timeout', pid }];
  let res;
  if (m.drawn && m.drawn.pid === pid) res = passAction(m, pid, now);
  else {
    res = drawAction(m, pid, now);
    if (res.ok && m.drawn && m.drawn.pid === pid) {
      const more = passAction(m, pid, now);
      if (more.ok) res.events.push(...more.events);
    }
  }
  if (!res.ok) return res;
  return { ok: true, events: [...events, ...res.events] };
}

function callUno(m, pid, now) {
  if (m.phase !== 'playing') return fail('NOT_PLAYING');
  const hand = m.hands[pid];
  if (!hand) return fail('NOT_IN_GAME');
  const u = m.uno[pid];
  if (hand.length === 1) {
    if (u.called) return fail('ALREADY_CALLED');
    if (u.vulnerableUntil <= now) return fail('TOO_LATE');
    u.called = true;
    u.vulnerableUntil = 0;
    m.stats[pid].unos += 1;
    return { ok: true, events: [{ type: 'uno', pid }] };
  }
  if (hand.length === 2) {
    if (u.called) return fail('ALREADY_CALLED');
    u.called = true;
    return { ok: true, events: [{ type: 'uno_armed', pid }] };
  }
  return fail('NOT_NEEDED');
}

function catchUno(m, byPid, targetPid, now) {
  if (m.phase !== 'playing') return fail('NOT_PLAYING');
  if (!m.hands[byPid] || !m.hands[targetPid]) return fail('NOT_IN_GAME');
  if (byPid === targetPid) return fail('CANNOT_CATCH_SELF');
  const u = m.uno[targetPid];
  if (m.hands[targetPid].length !== 1 || u.called || u.vulnerableUntil <= now) return fail('NOTHING_TO_CATCH');
  const events = [{ type: 'caught', by: byPid, target: targetPid }];
  m.stats[targetPid].penalties += 1;
  drawCards(m, targetPid, UNO_PENALTY_CARDS, 'uno_penalty', events);
  return { ok: true, events };
}

/** Close expired catch windows. Returns true when something changed. */
function expireUno(m, now) {
  let changed = false;
  if (m.phase !== 'playing') return false;
  for (const pid of m.order) {
    const u = m.uno[pid];
    if (u && u.vulnerableUntil && u.vulnerableUntil <= now) {
      u.vulnerableUntil = 0;
      changed = true;
    }
  }
  return changed;
}

function endRound(m, winnerId, now, events) {
  let points = 0;
  const leftovers = {};
  for (const pid of m.order) {
    if (pid === winnerId) continue;
    const sum = m.hands[pid].reduce((a, c) => a + cardPoints(c), 0);
    leftovers[pid] = { cards: m.hands[pid].length, points: sum };
    points += sum;
  }
  m.scores[winnerId] += points;
  for (const pid of m.order) m.uno[pid] = { called: false, vulnerableUntil: 0 };
  m.roundResult = { round: m.round, winnerId, points, leftovers, scores: { ...m.scores } };
  m.history.push(m.roundResult);
  m.turnEndsAt = 0;
  m.pending = null;
  m.drawn = null;
  events.push({ type: 'round_end', ...m.roundResult });
  if (m.scores[winnerId] >= m.settings.winningScore) {
    m.phase = 'finished';
    m.winnerId = winnerId;
    m.endedAt = now;
    m.endReason = 'score';
    events.push({ type: 'match_end', winnerId, reason: 'score' });
  } else {
    m.phase = 'round_over';
  }
}

/** A player leaves mid-match: their cards go to the bottom of the deck. */
function removePlayer(m, pid, now) {
  const idx = m.order.indexOf(pid);
  if (idx === -1) return fail('NOT_IN_GAME');
  const events = [{ type: 'player_left', pid }];
  const wasCurrent = idx === m.turnIdx && m.phase === 'playing';
  const hand = m.hands[pid] || [];
  m.deck.unshift(...hand);
  delete m.hands[pid];
  delete m.uno[pid];
  m.order.splice(idx, 1);
  const n = m.order.length;

  if (m.phase === 'finished') return { ok: true, events };
  if (n === 1 && m.phase !== 'idle') {
    m.phase = 'finished';
    m.winnerId = m.order[0];
    m.endedAt = now;
    m.endReason = 'forfeit';
    m.turnEndsAt = 0;
    events.push({ type: 'match_end', winnerId: m.winnerId, reason: 'forfeit' });
    return { ok: true, events };
  }
  if (n === 0) return { ok: true, events };
  if (idx < m.turnIdx) m.turnIdx -= 1;
  if (m.dealerIdx >= n || idx < m.dealerIdx) m.dealerIdx = Math.max(0, (m.dealerIdx - 1 + n) % n);
  if (wasCurrent) {
    m.pending = null;
    m.turnIdx = m.dir === 1 ? idx % n : (idx - 1 + n) % n;
    beginTurn(m, now, events);
  } else if (m.turnIdx >= n) {
    m.turnIdx = 0;
  }
  return { ok: true, events };
}

// ---------------------------------------------------------------- bots / autopilot

function chooseBotMove(m, pid, rng = Math.random) {
  const hand = m.hands[pid];
  if (!hand || m.phase !== 'playing' || currentId(m) !== pid) return null;
  const u = m.uno[pid];
  const playable = hand.filter((c) => isPlayable(m, pid, c));

  if (hand.length === 2 && !u.called && playable.length > 0 && rng() < 0.85) return { type: 'uno' };
  if (m.pending) {
    return playable.length ? { type: 'play', cardId: playable[0].id, color: bestColor(hand, playable[0], rng) } : { type: 'draw' };
  }
  if (!playable.length) return m.drawn && m.drawn.pid === pid ? { type: 'pass' } : { type: 'draw' };

  const nextId = m.order[nextIdx(m, m.turnIdx, 1)];
  const nextCount = m.hands[nextId] ? m.hands[nextId].length : 99;
  const counts = {};
  for (const c of hand) if (c.color) counts[c.color] = (counts[c.color] || 0) + 1;
  const score = (c) => {
    let s = 0;
    if (c.kind === 'wild4') s -= 40;
    else if (c.kind === 'wild') s -= 25;
    else {
      s += (counts[c.color] || 0) * 2;
      if (c.kind === 'num') s += c.value / 3;
      else {
        s += 3;
        if (nextCount <= 2) s += 12;
      }
    }
    if (hand.length <= 2 && (c.kind === 'wild' || c.kind === 'wild4')) s += 30;
    return s + rng();
  };
  const best = playable.slice().sort((a, b) => score(b) - score(a))[0];
  return { type: 'play', cardId: best.id, color: bestColor(hand, best, rng) };
}

function bestColor(hand, card, rng) {
  const counts = { red: 0, blue: 0, yellow: 0, green: 0 };
  for (const c of hand) if (c.color && c.id !== card.id) counts[c.color] += 1;
  const best = COLORS.slice().sort((a, b) => counts[b] - counts[a] || rng() - 0.5)[0];
  return best;
}

// ---------------------------------------------------------------- helpers for the room layer

module.exports = {
  COLORS, UNO_CATCH_WINDOW_MS, UNO_PENALTY_CARDS, DEFAULT_SETTINGS, SETTING_OPTIONS,
  sanitizeSettings, buildDeck, shuffle, cardLabel, cardPoints,
  createMatch, startRound, playCard, drawAction, passAction, timeoutTurn,
  callUno, catchUno, expireUno, removePlayer, chooseBotMove,
  isPlayable, playableIds, jumpInIds, canJumpIn, canDraw, canPass, currentId, topCard,
};
