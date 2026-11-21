// Screen 3 — Main game arena.
// The server is authoritative: this screen renders the per-player view it is sent and turns the events
// that caused each change into animation, sound and log lines. Nothing here decides whether a move is legal.
import { h, s, clear, Disposer } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, logoMark } from '../avatars.js';
import { cardEl, backEl, sortHand, cardName, COLOR_NAME } from '../cards.js';
import { store, serverNow, reducedMotion } from '../store.js';
import { action } from '../net.js';
import { soundControl, toast, confirmModal, openModal, copyText } from '../ui.js';
import { audio } from '../audio.js';
import { fly, rectOf, shake, popIn, pulse } from '../anim.js';
import { burst } from '../fx.js';

const SEAT_LAYOUT = { 1: ['top'], 2: ['top-left', 'top-right'], 3: ['left', 'top-left', 'top-right'] };
const RING_R = 34;
const RING_C = 2 * Math.PI * RING_R;
const COLOR_CSS = { red: 'var(--red)', blue: 'var(--blue)', yellow: 'var(--yellow)', green: 'var(--green)' };

export function createArena(ctx) {
  const d = new Disposer();
  let st = store.state;
  const me = st.me;
  const names = new Map();
  const seatEls = new Map();      // pid -> seat controller
  const handEls = new Map();      // card id -> wrapper element
  let sortMode = 'colour';
  let selectedId = null;
  let armedLocal = false;
  let lastTurnId = null;
  let lastPhase = null;
  let lastRound = 0;
  let pileHeld = 0;
  let pileTimer = null;
  let myFlight = null;            // { id, promise }
  let chain = Promise.resolve();
  let backlog = 0;
  let drag = null;
  let tickSecond = -1;
  const logItems = [];

  const player = (pid) => st.players.find((p) => p.id === pid);
  const nameOf = (pid) => (pid === me ? 'You' : (names.get(pid) || 'Player'));
  const refreshNames = () => { for (const p of st.players) names.set(p.id, p.name); };
  refreshNames();

  // ================================================================= DOM
  const codeChip = h('button', { class: 'chip code-chip', title: 'Copy room code', 'aria-label': `Room code ${st.code}. Click to copy`, onclick: async () => {
    const ok = await copyText(st.code); toast(ok ? 'ROOM CODE COPIED' : 'COULD NOT COPY', ok ? 'good' : 'error');
  } }, icon('hash'), h('span', { class: 'mono' }, st.code));
  const roundChip = h('span', { class: 'chip' }, 'Round 1');
  const colorDot = h('i', { class: 'color-dot' });
  const colorName = h('span', {}, '');
  const colorChip = h('span', { class: 'chip color-chip', title: 'Current colour' }, colorDot, colorName);
  const dirIcon = icon('repeat');
  const dirChip = h('span', { class: 'chip dir-chip', title: 'Direction of play' }, dirIcon, h('span', { class: 'dir-text' }, 'Clockwise'));
  const timeText = h('span', { class: 'mono' }, '0:00');
  const timeChip = h('span', { class: 'chip', title: 'Match time' }, icon('clock'), timeText);

  const hud = h('header', { class: 'hud' },
    h('div', { class: 'hud-left' }, h('div', { class: 'brand mini' }, logoMark()), roundChip, codeChip),
    h('div', { class: 'hud-mid' }, colorChip, dirChip, timeChip),
    h('div', { class: 'hud-right' }, soundControl(),
      h('button', { class: 'icon-btn', 'aria-label': 'Leave match', title: 'Leave match', onclick: leaveMatch }, icon('logout'))));

  // table
  const drawCount = h('span', { class: 'pile-count mono' }, '0');
  const drawStack = h('div', { class: 'draw-stack' }, backEl({ size: 'pile', cls: 'ds3' }), backEl({ size: 'pile', cls: 'ds2' }), backEl({ size: 'pile', cls: 'ds1' }));
  const pendingBadge = h('div', { class: 'pending-badge', hidden: true }, '+2');
  const drawBtn = h('button', { class: 'draw-pile', 'aria-label': 'Draw a card', onclick: () => doDraw() }, drawStack, pendingBadge, h('span', { class: 'pile-label' }, 'Draw', drawCount));
  const discardSlot = h('div', { class: 'discard-slot' });
  const discardGlow = h('div', { class: 'discard-glow' });
  const discard = h('div', { class: 'discard-pile', 'aria-label': 'Discard pile' }, discardGlow, discardSlot);
  const dirRing = h('div', { class: 'dir-ring', 'aria-hidden': 'true' },
    s('svg', { viewBox: '0 0 400 400' },
      s('circle', { cx: 200, cy: 200, r: 188, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-dasharray': '2 20', 'stroke-linecap': 'round' }),
      ...[0, 90, 180, 270].map((a) => s('path', { d: 'M200 8 l-9 -13 M200 8 l-9 13', transform: `rotate(${a} 200 200)`, stroke: 'currentColor', 'stroke-width': 4, 'stroke-linecap': 'round', fill: 'none' }))));
  const narrowMq = window.matchMedia('(max-width: 760px)');
  const hint = h('div', { class: 'hint', role: 'status', 'aria-live': 'polite' }, '');
  const bannerLayer = h('div', { class: 'banners', 'aria-live': 'assertive' });
  const table = h('div', { class: 'table' }, dirRing, h('div', { class: 'felt' }), h('div', { class: 'piles' }, drawBtn, discard), hint, bannerLayer);
  const seatsEl = h('div', { class: 'seats' });
  const logEl = h('ul', { class: 'log', 'aria-label': 'Game log', 'aria-live': 'polite' });
  const stage = h('div', { class: 'stage' }, seatsEl, table, logEl);

  // hand zone
  const handTrack = h('div', { class: 'hand-track' });
  const handScroll = h('div', { class: 'hand-scroll', role: 'list', 'aria-label': 'Your hand' }, handTrack);
  const ringSvg = s('svg', { class: 'ring', viewBox: '0 0 80 80', 'aria-hidden': 'true' },
    s('circle', { cx: 40, cy: 40, r: RING_R, class: 'ring-bg' }),
    s('circle', { cx: 40, cy: 40, r: RING_R, class: 'ring-fg', 'stroke-dasharray': RING_C, 'stroke-dashoffset': RING_C, transform: 'rotate(-90 40 40)' }));
  const myRingFg = ringSvg.querySelector('.ring-fg');
  const mySeconds = h('div', { class: 'me-seconds mono', 'aria-hidden': 'true' }, '');
  const myAvatarWrap = h('div', { class: 'me-avatar' }, ringSvg, avatar(player(me).avatar, 52), mySeconds);
  const myName = h('div', { class: 'me-name ellipsis' }, player(me).name);
  const myStatus = h('div', { class: 'me-status' }, '');
  const myScore = h('div', { class: 'me-score mono' }, '0 pts');
  const sortBtn = (mode, label) => h('button', { 'aria-pressed': String(sortMode === mode), onclick: () => { sortMode = mode; audio.play('click'); paintSort(); renderHand(false); } }, label);
  const sortSeg = h('div', { class: 'seg sort-seg', role: 'group', 'aria-label': 'Sort hand' });
  function paintSort() { clear(sortSeg); sortSeg.append(h('span', { class: 'sort-ic', 'aria-hidden': 'true' }, icon('sort')), sortBtn('colour', 'Colour'), sortBtn('number', 'Number')); }
  paintSort();
  const passBtn = h('button', { class: 'btn sm ghost pass-btn', hidden: true, onclick: () => doPass() }, 'Keep & pass');
  const meBar = h('div', { class: 'me-bar' },
    h('div', { class: 'me-left' }, myAvatarWrap, h('div', { class: 'me-meta' }, myName, myStatus, myScore)),
    h('div', { class: 'me-right' }, passBtn, sortSeg));
  const zone = h('div', { class: 'hand-zone' }, meBar, handScroll);

  const unoLabel = h('span', { class: 'uno-label' }, 'UNO');
  const unoSub = h('span', { class: 'uno-sub' }, '');
  const unoBtn = h('button', { class: 'uno-btn', hidden: true, 'aria-label': 'Call UNO', onclick: () => doUno() }, unoLabel, unoSub);
  const overlay = h('div', { class: 'arena-overlay', hidden: true });

  const el = h('div', { class: 'arena' }, hud, stage, zone, unoBtn, overlay);

  // ================================================================= sizing
  function setSizes() {
    const w = window.innerWidth; const hgt = window.innerHeight;
    const cw = Math.round(Math.max(58, Math.min(104, hgt * 0.128, w * 0.19)));
    const pw = Math.round(Math.max(70, Math.min(124, hgt * 0.15, w * 0.22)));
    const root = document.documentElement.style;
    root.setProperty('--hand-cw', cw + 'px');
    root.setProperty('--pile-cw', pw + 'px');
    return cw;
  }

  // ================================================================= hud
  function renderHud() {
    const g = st.game;
    roundChip.textContent = `Round ${g.round}`;
    const c = g.activeColor;
    colorDot.className = 'color-dot ' + (c || '');
    colorName.textContent = c ? COLOR_NAME[c] : '—';
    colorChip.style.setProperty('--cc', c ? COLOR_CSS[c] : 'var(--text-3)');
    dirChip.classList.toggle('ccw', g.dir === -1);
    dirChip.querySelector('.dir-text').textContent = g.dir === -1 ? 'Counter-clockwise' : 'Clockwise';
    dirRing.classList.toggle('ccw', g.dir === -1);
    table.dataset.color = c || '';
    discard.dataset.color = c || '';
  }

  function renderTime() {
    const ms = Math.max(0, serverNow() - st.game.startedAt);
    const sec = Math.floor(ms / 1000);
    timeText.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  // ================================================================= seats
  function seatOrder() {
    const order = st.game.turnOrder;
    const i = order.indexOf(me);
    const rotated = i === -1 ? order.slice() : [...order.slice(i + 1), ...order.slice(0, i)];
    return rotated.filter((pid) => pid !== me);
  }

  function makeSeat(pid) {
    const ringFg = s('circle', { cx: 40, cy: 40, r: RING_R, class: 'ring-fg', 'stroke-dasharray': RING_C, 'stroke-dashoffset': RING_C, transform: 'rotate(-90 40 40)' });
    const ring = s('svg', { class: 'ring', viewBox: '0 0 80 80', 'aria-hidden': 'true' }, s('circle', { cx: 40, cy: 40, r: RING_R, class: 'ring-bg' }), ringFg);
    const p = player(pid);
    const av = h('div', { class: 'seat-avatar' }, ring, avatar(p.avatar, 52));
    const nameEl = h('div', { class: 'seat-name ellipsis' }, p.name);
    const tags = h('div', { class: 'seat-tags' });
    const fan = h('div', { class: 'seat-fan', 'aria-hidden': 'true' });
    const count = h('span', { class: 'seat-count mono' }, '0');
    const score = h('span', { class: 'seat-score mono' }, '0 pts');
    const flag = h('div', { class: 'seat-flag', hidden: true });
    const secs = h('span', { class: 'seat-secs mono' }, '');
    const root = h('div', { class: 'seat', dataset: { pid } },
      h('div', { class: 'seat-top' }, av, h('div', { class: 'seat-info' }, nameEl, tags, score)),
      h('div', { class: 'seat-hand' }, fan, count, secs),
      flag);
    return { pid, root, av, ringFg, nameEl, tags, fan, count, score, flag, secs, fanN: 0 };
  }

  function renderSeats() {
    const order = seatOrder();
    const slots = SEAT_LAYOUT[Math.min(order.length, 3)] || [];
    for (const [pid, seat] of [...seatEls]) {
      if (!order.includes(pid)) { seat.root.remove(); seatEls.delete(pid); }
    }
    order.forEach((pid, i) => {
      const p = player(pid);
      if (!p) return;
      let seat = seatEls.get(pid);
      if (!seat) { seat = makeSeat(pid); seatEls.set(pid, seat); seatsEl.append(seat.root); }
      seat.root.className = `seat pos-${slots[i] || 'top'}`;
      seat.nameEl.textContent = p.name;
      seat.score.textContent = `${p.score} pts`;
      seat.root.classList.toggle('turn', st.game.turnId === pid && st.game.phase === 'playing');
      seat.root.classList.toggle('offline', !p.connected);
      clear(seat.tags);
      if (p.isHost) seat.tags.append(h('span', { class: 'tag host', title: 'Host' }, icon('crown')));
      if (p.isBot) seat.tags.append(h('span', { class: 'tag bot' }, 'Bot'));
      else if (!p.connected) seat.tags.append(h('span', { class: 'tag off' }, icon('wifiOff'), 'Auto'));
      else if (p.afk) seat.tags.append(h('span', { class: 'tag off' }, 'Auto'));
      // card fan: show up to 7 backs
      const shown = Math.min(p.cards, 7);
      while (seat.fanN < shown) { seat.fan.append(backEl({ size: 'xs' })); seat.fanN++; }
      while (seat.fanN > shown) { seat.fan.lastElementChild.remove(); seat.fanN--; }
      [...seat.fan.children].forEach((c, k) => { c.style.setProperty('--k', k); c.style.setProperty('--n', shown); });
      seat.count.textContent = String(p.cards);
      seat.root.classList.toggle('one', p.cards === 1);
      // UNO flag / catch
      clear(seat.flag);
      const catchable = p.uno && p.uno.catchUntil > serverNow();
      if (catchable) {
        seat.flag.hidden = false;
        seat.flag.append(h('button', { class: 'catch-btn', onclick: () => doCatch(pid) }, icon('zap'), 'Catch UNO!'));
      } else if (p.uno && p.uno.called && p.cards === 1) {
        seat.flag.hidden = false;
        seat.flag.append(h('span', { class: 'uno-pill' }, 'UNO!'));
      } else seat.flag.hidden = true;
    });
  }

  // ================================================================= piles
  function renderPile(holdCount = 0) {
    const g = st.game;
    const cards = holdCount ? g.pile.slice(0, Math.max(0, g.pile.length - holdCount)) : g.pile;
    clear(discardSlot);
    for (const c of cards) {
      const e = cardEl(c, { size: 'pile' });
      const rot = ((c.id * 37) % 21) - 10;
      const ox = ((c.id * 13) % 15) - 7;
      const oy = ((c.id * 29) % 11) - 5;
      e.style.transform = `translate(${ox}px, ${oy}px) rotate(${rot}deg)`;
      discardSlot.append(e);
    }
    drawCount.textContent = String(g.deckCount);
    drawStack.style.opacity = g.deckCount === 0 ? '0.25' : '1';
  }

  function releasePile() {
    pileHeld = 0;
    clearTimeout(pileTimer);
    renderPile(0);
  }

  // ================================================================= hand
  function cardW() { return Math.round(Math.max(58, Math.min(104, window.innerHeight * 0.128, window.innerWidth * 0.19))); }

  function isLegal(id) { return st.game.playable.includes(id) || st.game.jumpIn.includes(id); }

  function makeHandCard(card) {
    const w = h('div', { class: 'hand-card', role: 'listitem', tabindex: 0, 'aria-label': cardName(card), dataset: { id: card.id } }, cardEl(card, { size: 'hand' }), h('i', { class: 'badge' }));
    w.addEventListener('pointerdown', (e) => onPointerDown(e, card, w));
    w.addEventListener('pointermove', (e) => onPointerMove(e, card, w));
    w.addEventListener('pointerup', (e) => onPointerUp(e, card, w));
    w.addEventListener('pointercancel', (e) => cancelDrag(e, w));
    w.addEventListener('keydown', (e) => onCardKey(e, card, w));
    w.addEventListener('mouseenter', () => { if (st.game.playable.includes(card.id)) audio.play('hover'); });
    return w;
  }

  function renderHand(animate) {
    const g = st.game;
    const cards = sortHand(g.hand, sortMode);
    const ids = new Set(cards.map((c) => c.id));
    for (const [id, w] of [...handEls]) {
      if (!ids.has(id)) { w.remove(); handEls.delete(id); if (selectedId === id) selectedId = null; }
    }
    const fresh = [];
    for (const c of cards) {
      if (!handEls.has(c.id)) {
        const w = makeHandCard(c);
        handEls.set(c.id, w);
        handTrack.append(w);
        fresh.push(w);
      }
    }
    layoutHand(cards, fresh, animate);
    const myTurn = g.turnId === me && g.phase === 'playing';
    for (const c of cards) {
      const w = handEls.get(c.id);
      const playable = g.playable.includes(c.id);
      const jump = g.jumpIn.includes(c.id);
      w.classList.toggle('playable', playable);
      w.classList.toggle('jumpin', jump && !playable);
      w.classList.toggle('dimmed', myTurn && !playable && !jump);
      w.classList.toggle('selected', selectedId === c.id);
      w.setAttribute('aria-disabled', String(!(playable || jump)));
    }
  }

  function layoutHand(cards, fresh, animate) {
    const n = cards.length;
    const cw = cardW();
    const ch = cw * 1.5;
    const W = handScroll.clientWidth || window.innerWidth;
    const pad = 14;
    const maxSp = cw * 0.62;
    const minSp = cw * 0.36;
    let sp = n > 1 ? Math.min(maxSp, (W - cw - pad * 2) / (n - 1)) : 0;
    let scrolling = false;
    if (n > 1 && sp < minSp) { sp = minSp; scrolling = true; }
    const content = n > 0 ? (n - 1) * sp + cw : 0;
    const trackW = Math.max(W, content + pad * 2);
    handTrack.style.width = trackW + 'px';
    handTrack.style.height = Math.round(ch + 70) + 'px';
    handScroll.classList.toggle('scrolling', scrolling);
    const start = (trackW - content) / 2;
    const step = !scrolling && n > 1 ? Math.min(4.4, 40 / (n - 1)) : 0;

    let origin = null;
    if (animate && fresh.length) {
      const tr = handTrack.getBoundingClientRect();
      const pr = rectOf(drawBtn.querySelector('.draw-stack'));
      origin = { x: pr.cx - tr.left - cw / 2, y: pr.cy - (tr.bottom - ch / 2) };
    }
    cards.forEach((c, i) => {
      const w = handEls.get(c.id);
      const t = i - (n - 1) / 2;
      const x = start + i * sp;
      const y = scrolling ? 0 : t * t * cw * 0.014;
      w.style.zIndex = String(i + 1);
      if (origin && fresh.includes(w)) {
        w.classList.add('noanim');
        w.style.setProperty('--x', origin.x + 'px');
        w.style.setProperty('--y', origin.y + 'px');
        w.style.setProperty('--fr', '0deg');
        w.style.setProperty('--sc', '0.55');
        w.style.opacity = '0';
        void w.offsetWidth;
        const k = fresh.indexOf(w);
        w.style.setProperty('--delay', Math.min(k, 12) * (fresh.length > 4 ? 60 : 110) + 'ms');
        w.classList.remove('noanim');
        w.style.opacity = '';
        setTimeout(() => w.style.removeProperty('--delay'), 1400);
      }
      w.style.setProperty('--x', x + 'px');
      w.style.setProperty('--y', y + 'px');
      w.style.setProperty('--fr', t * step + 'deg');
      w.style.removeProperty('--sc');
    });
  }

  // ================================================================= interaction: tap / drag / keyboard
  function tapCard(card, w, pointerType) {
    if (!isLegal(card.id)) { illegalFeedback(card, w); return; }
    if (pointerType === 'touch' && selectedId !== card.id) {
      selectedId = card.id;
      audio.play('click');
      renderHand(false);
      return;
    }
    selectedId = null;
    attemptPlay(card, w);
  }

  function illegalFeedback(card, w) {
    const g = st.game;
    let msg = 'THAT CARD CANNOT BE PLAYED NOW.';
    if (g.phase !== 'playing') msg = 'WAIT FOR THE NEXT ROUND.';
    else if (g.turnId !== me) msg = 'IT IS NOT YOUR TURN.';
    else if (g.pending) msg = 'STACK A MATCHING DRAW CARD OR DRAW THE PENALTY.';
    else if (g.drawnCardId !== null && g.drawnCardId !== card.id) msg = 'YOU CAN ONLY PLAY THE CARD YOU JUST DREW.';
    else if (card.kind === 'wild4') msg = 'WILD DRAW FOUR ONLY WORKS WHEN YOU HAVE NO CARD OF THE CURRENT COLOUR.';
    shake(w);
    audio.play('error');
    toast(msg, 'error', 2400);
  }

  function onPointerDown(e, card, w) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag = { id: card.id, x: e.clientX, y: e.clientY, started: false, pid: e.pointerId, type: e.pointerType, ghost: null, w };
    try { w.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  }

  function onPointerMove(e, card, w) {
    if (!drag || drag.pid !== e.pointerId || drag.id !== card.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.started) {
      const touch = drag.type === 'touch';
      const go = touch ? (dy < -16 && Math.abs(dy) > Math.abs(dx) * 1.2) : Math.hypot(dx, dy) > 8;
      if (!go) return;
      beginDrag(card, w, e);
    }
    moveDrag(e);
  }

  function beginDrag(card, w, e) {
    drag.started = true;
    const inner = w.querySelector('.uno-card');
    const r = inner.getBoundingClientRect();
    const ghost = cardEl(card, { size: 'hand' });
    ghost.style.setProperty('--cw', r.width + 'px');
    Object.assign(ghost.style, { position: 'fixed', left: '0px', top: '0px', zIndex: '70', pointerEvents: 'none', transition: 'none', filter: 'drop-shadow(0 18px 24px rgba(0,0,0,.5))' });
    document.getElementById('flight-layer').append(ghost);
    drag.ghost = ghost;
    drag.gw = r.width; drag.gh = r.height;
    drag.offX = e.clientX - (r.left + r.width / 2);
    drag.offY = e.clientY - (r.top + r.height / 2);
    w.classList.add('dragging');
    table.classList.add(isLegal(card.id) ? 'drop-ok' : 'drop-no');
    audio.play('click');
  }

  function overTable(x, y) {
    const r = table.getBoundingClientRect();
    const pad = 24;
    return x > r.left - pad && x < r.right + pad && y > r.top - pad && y < r.bottom + pad;
  }

  function moveDrag(e) {
    if (!drag || !drag.ghost) return;
    const x = e.clientX - drag.offX;
    const y = e.clientY - drag.offY;
    drag.ghost.style.transform = `translate(${x - drag.gw / 2}px, ${y - drag.gh / 2}px) rotate(${Math.max(-12, Math.min(12, (e.clientX - drag.x) / 12))}deg) scale(1.08)`;
    table.classList.toggle('drop-hot', overTable(e.clientX, e.clientY));
  }

  function endDragVisuals() {
    table.classList.remove('drop-ok', 'drop-no', 'drop-hot');
  }

  function onPointerUp(e, card, w) {
    if (!drag || drag.pid !== e.pointerId) return;
    const wasDrag = drag.started;
    const type = drag.type;
    const ghost = drag.ghost;
    drag = null;
    try { w.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    if (!wasDrag) { tapCard(card, w, type); return; }
    endDragVisuals();
    w.classList.remove('dragging');
    if (overTable(e.clientX, e.clientY)) {
      if (isLegal(card.id)) {
        if (ghost) ghost.remove();
        attemptPlay(card, w, { fromRect: ghost ? ghostRect(ghost) : null });
      } else { if (ghost) ghost.remove(); illegalFeedback(card, w); }
    } else if (ghost) {
      const from = ghostRect(ghost);
      const to = rectOf(w.querySelector('.uno-card'));
      w.classList.add('flying');
      ghost.style.transform = '';
      fly(ghost, from, to, { duration: 260 }).then(() => w.classList.remove('flying'));
    }
  }

  function ghostRect(g) {
    const r = g.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }

  function cancelDrag(e, w) {
    if (!drag || drag.pid !== e.pointerId) return;
    if (drag.ghost) drag.ghost.remove();
    w.classList.remove('dragging');
    endDragVisuals();
    drag = null;
  }

  function onCardKey(e, card, w) {
    const order = [...handTrack.children].sort((a, b) => Number(a.style.zIndex) - Number(b.style.zIndex));
    const i = order.indexOf(w);
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectedId = null; if (!isLegal(card.id)) illegalFeedback(card, w); else attemptPlay(card, w); }
    else if (e.key === 'ArrowRight' && order[i + 1]) { e.preventDefault(); order[i + 1].focus(); }
    else if (e.key === 'ArrowLeft' && order[i - 1]) { e.preventDefault(); order[i - 1].focus(); }
  }

  const onGlobalKey = (e) => {
    if (document.querySelector('.modal-backdrop')) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT') return;
    if (e.key === 'd' || e.key === 'D') { doDraw(); }
    else if (e.key === 'p' || e.key === 'P') { doPass(); }
    else if (e.key === 'u' || e.key === 'U') { doUno(); }
  };
  d.on(window, 'keydown', onGlobalKey);

  // ================================================================= actions
  function pickColor() {
    return new Promise((resolve) => {
      let m;
      const choose = (c) => { audio.play('click'); resolve(c); m.close('picked'); };
      const key = (e) => {
        const c = { r: 'red', b: 'blue', y: 'yellow', g: 'green', 1: 'red', 2: 'blue', 3: 'yellow', 4: 'green' }[e.key.toLowerCase()];
        if (c) { e.preventDefault(); e.stopPropagation(); choose(c); }
      };
      const btn = (cls, c, k) => h('button', { class: cls, 'aria-label': COLOR_NAME[c], onclick: () => choose(c) }, h('span', { class: 'kb' }, k), COLOR_NAME[c]);
      m = openModal([
        h('h2', { class: 'center' }, 'Choose a colour'),
        h('p', { class: 'center' }, 'Pick the colour the next player must match.'),
        h('div', { class: 'color-pick round' }, btn('r', 'red', 'R'), btn('b', 'blue', 'B'), btn('y', 'yellow', 'Y'), btn('g', 'green', 'G')),
        h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => m.close('cancel') }, 'Cancel')),
      ], { label: 'Choose a colour', onClose: (r) => { document.removeEventListener('keydown', key, true); if (r !== 'picked') resolve(null); } });
      document.addEventListener('keydown', key, true);
      setTimeout(() => m.el.querySelector('.color-pick button').focus(), 40);
    });
  }

  async function attemptPlay(card, w, opts = {}) {
    if (myFlight) return;
    let color;
    if (card.kind === 'wild' || card.kind === 'wild4') {
      color = await pickColor();
      if (!color) { renderHand(false); return; }
    }
    // optimistic flight: the card leaves the hand at once; if the server refuses it comes back
    const inner = w.querySelector('.uno-card');
    const from = opts.fromRect || rectOf(inner);
    const ghost = cardEl(card, { size: 'pile' });
    w.classList.add('flying');
    const to = rectOf(discardSlot);
    const rot = ((card.id * 37) % 21) - 10;
    const flight = fly(ghost, from, to, { duration: 360, rotateFrom: 0, rotateTo: rot });
    myFlight = { id: card.id, promise: flight };
    audio.play('play');
    const res = await action('play', { cardId: card.id, color });
    if (!res.ok) {
      ghost.remove();
      myFlight = null;
      w.classList.remove('flying');
      shake(w);
      audio.play('error');
      toast(res.message || 'THAT MOVE WAS REFUSED.', 'error');
      renderHand(false);
      return;
    }
    flight.then(() => { if (myFlight && myFlight.id === card.id) myFlight = null; });
  }

  async function doDraw() {
    const g = st.game;
    if (g.phase !== 'playing') return;
    if (g.turnId !== me) { shake(drawBtn); audio.play('error'); toast('IT IS NOT YOUR TURN.', 'error', 1800); return; }
    if (!g.canDraw) { shake(drawBtn); audio.play('error'); toast('YOU HAVE ALREADY DRAWN — PLAY THE CARD OR PASS.', 'error', 2200); return; }
    const res = await action('draw');
    if (!res.ok) { audio.play('error'); toast(res.message, 'error'); }
  }

  async function doPass() {
    const g = st.game;
    if (g.phase !== 'playing' || g.turnId !== me || !g.canPass) return;
    const res = await action('pass');
    if (!res.ok) toast(res.message, 'error');
  }

  async function doUno() {
    const res = await action('uno');
    if (res.ok || res.error === 'ALREADY_CALLED') { if (st.game.hand.length === 2) armedLocal = true; renderControls(); }
    else { audio.play('error'); toast(res.message, 'error', 2200); }
  }

  async function doCatch(pid) {
    const res = await action('catch', { target: pid });
    if (!res.ok) { audio.play('error'); toast(res.message, 'error', 2000); }
  }

  async function leaveMatch() {
    const ok = await confirmModal({
      title: 'Leave the match?',
      body: 'Your cards go back to the deck and you leave the room. You cannot rejoin a match in progress.',
      confirmLabel: 'Leave match', cancelLabel: 'Keep playing', danger: true,
    });
    if (ok) ctx.leave();
  }

  // ================================================================= controls
  function renderControls() {
    const g = st.game;
    const meP = player(me);
    const myTurn = g.turnId === me && g.phase === 'playing';
    drawBtn.classList.toggle('can-draw', myTurn && g.canDraw);
    drawBtn.classList.toggle('nudge', myTurn && g.canDraw && g.playable.length === 0);
    pendingBadge.hidden = !g.pending;
    if (g.pending) pendingBadge.textContent = `+${g.pending.amount}`;
    passBtn.hidden = !(myTurn && g.canPass);

    // timer rings
    myAvatarWrap.classList.toggle('turn', myTurn);
    el.classList.toggle('my-turn', myTurn);

    // hint line
    let text = '';
    let shortText = '';
    if (g.phase === 'playing') {
      if (myTurn) {
        if (g.pending) { text = `Stack a ${g.pending.kind === 'draw2' ? '+2' : '+4'} or draw ${g.pending.amount} cards`; shortText = `Stack or draw ${g.pending.amount}`; }
        else if (g.drawnCardId !== null) { text = 'Play the drawn card, or keep it and pass'; shortText = 'Play it or pass'; }
        else if (g.playable.length) { text = 'Your turn — play a card'; shortText = 'Your turn'; }
        else { text = 'No playable card — draw from the pile'; shortText = 'Draw a card'; }
      } else if (g.turnId) text = `${nameOf(g.turnId)}${g.turnId === me ? '' : "'s"} turn`;
    }
    hint.textContent = text;
    hint.classList.toggle('mine', myTurn);

    // my status line
    const status = [];
    if (meP.afk) status.push('Autopilot — make a move to take over');
    else if (myTurn) status.push(narrowMq.matches && shortText ? shortText : 'Your turn');
    myStatus.textContent = status.join(' · ');
    myScore.textContent = `${meP.score} pts · ${g.hand.length} ${g.hand.length === 1 ? 'card' : 'cards'}`;

    // UNO button
    const n = g.hand.length;
    const catching = meP.uno && meP.uno.catchUntil > serverNow() && n === 1;
    if (n !== 2) armedLocal = false;
    const showUno = g.phase === 'playing' && (n === 2 || catching);
    unoBtn.hidden = !showUno;
    unoBtn.classList.toggle('armed', n === 2 && armedLocal);
    unoBtn.classList.toggle('urgent', !!catching);
    unoLabel.textContent = n === 2 && armedLocal ? '✓' : 'UNO';
    unoSub.textContent = catching ? 'NOW!' : (n === 2 ? (armedLocal ? 'READY' : 'CALL') : '');
    unoBtn.disabled = n === 2 && armedLocal;
  }

  // ================================================================= timer ring loop
  let raf = 0;
  function frame() {
    const g = st && st.game;
    if (g && g.phase === 'playing' && g.turnId) {
      const total = g.turnSeconds * 1000;
      const left = Math.max(0, g.turnEndsAt - serverNow());
      const frac = Math.min(1, left / total);
      const off = RING_C * (1 - frac);
      const urgent = left < 8000;
      const mine = g.turnId === me;
      const fg = mine ? myRingFg : (seatEls.get(g.turnId) || {}).ringFg;
      for (const sx of [myRingFg, ...[...seatEls.values()].map((x) => x.ringFg)]) {
        if (sx !== fg) { sx.style.strokeDashoffset = String(RING_C); sx.classList.remove('urgent'); }
      }
      if (fg) { fg.style.strokeDashoffset = String(off); fg.classList.toggle('urgent', urgent); }
      const secs = Math.ceil(left / 1000);
      mySeconds.textContent = mine ? String(secs) : '';
      mySeconds.classList.toggle('urgent', mine && urgent);
      for (const seat of seatEls.values()) seat.secs.textContent = seat.pid === g.turnId ? `${secs}s` : '';
      if (mine && secs <= 5 && secs > 0 && secs !== tickSecond) { tickSecond = secs; audio.play('tick'); }
      if (!mine) tickSecond = -1;
    } else {
      myRingFg.style.strokeDashoffset = String(RING_C);
      mySeconds.textContent = '';
      for (const seat of seatEls.values()) { seat.ringFg.style.strokeDashoffset = String(RING_C); seat.secs.textContent = ''; }
    }
    // catch windows closing without a push
    const now = serverNow();
    for (const [pid, seat] of seatEls) {
      const p = player(pid);
      if (p && p.uno && p.uno.catchUntil && p.uno.catchUntil <= now && seat.flag.querySelector('.catch-btn')) { seat.flag.hidden = true; clear(seat.flag); }
    }
    if (st.game && st.game.phase === 'round_over') updateOverlayTimer();
    raf = requestAnimationFrame(frame);
  }

  // ================================================================= banners + log
  function banner(text, { kind = '', ic = null, color = null } = {}) {
    while (bannerLayer.children.length >= 1) bannerLayer.firstElementChild.remove();
    const b = h('div', { class: `banner ${kind}` }, ic ? icon(ic) : null, color ? h('i', { class: 'color-dot ' + color }) : null, h('span', {}, text));
    bannerLayer.append(b);
    popIn(b, { duration: 420 });
    setTimeout(() => { b.classList.add('out'); setTimeout(() => b.remove(), 320); }, 1150);
  }

  function pushLog(text, { ic = null, tone = '' } = {}) {
    logItems.push({ text, ic, tone });
    while (logItems.length > 5) logItems.shift();
    clear(logEl);
    logItems.forEach((it, i) => {
      const li = h('li', { class: `log-item ${it.tone}`, style: { opacity: String(0.35 + 0.65 * ((i + 1) / logItems.length)) } }, it.ic ? icon(it.ic) : h('i', { class: 'log-dot' }), h('span', {}, it.text));
      logEl.append(li);
    });
  }

  const seatCenter = (pid) => {
    if (pid === me) return rectOf(myAvatarWrap);
    const seat = seatEls.get(pid);
    return seat ? rectOf(seat.av) : rectOf(table);
  };

  // ================================================================= events → cosmetics
  async function handleEvent(ev) {
    const g = st.game;
    switch (ev.type) {
      case 'round_start':
        pushLog(`Round ${ev.round} begins`, { ic: 'sparkles' });
        banner(`ROUND ${ev.round}`, { kind: 'round', ic: 'sparkles' });
        audio.play('deal');
        break;
      case 'play': {
        const who = nameOf(ev.pid);
        let line = `${who} played ${cardName(ev.card)}`;
        if (ev.jumpIn) line += ' — jump-in!';
        if (ev.card.kind === 'wild' || ev.card.kind === 'wild4') line += ` → ${COLOR_NAME[ev.color]}`;
        pushLog(line, { ic: ev.card.kind === 'wild' || ev.card.kind === 'wild4' ? 'sparkles' : 'play' });
        if (ev.pid !== me) {
          audio.play('play');
          if (backlog <= 5) {
            const ghost = cardEl(ev.card, { size: 'pile' });
            const from = seatCenter(ev.pid);
            const rot = ((ev.card.id * 37) % 21) - 10;
            await fly(ghost, from, rectOf(discardSlot), { duration: 420, rotateFrom: -18, rotateTo: rot });
          }
        } else if (myFlight) {
          await myFlight.promise;
        }
        if (pileHeld > 0) { pileHeld -= 1; if (pileHeld === 0) releasePile(); }
        const r = rectOf(discardSlot);
        burst(r.cx, r.cy, ev.color ? { red: '#FF414B', blue: '#287BFF', yellow: '#F9D83D', green: '#27C978' }[ev.color] : '#fff', ev.card.kind === 'num' ? 12 : 26);
        if (ev.card.kind === 'draw2') banner('DRAW TWO', { kind: 'pen', ic: 'layers' });
        else if (ev.card.kind === 'wild4') banner('WILD DRAW FOUR', { kind: 'pen', ic: 'layers' });
        else if (ev.card.kind === 'wild') { audio.play('wild'); }
        break;
      }
      case 'color':
        banner(`COLOUR: ${COLOR_NAME[ev.color].toUpperCase()}`, { kind: 'color', color: ev.color });
        audio.play('wild');
        break;
      case 'draw': {
        const who = nameOf(ev.pid);
        const penalty = ev.reason === 'penalty' || ev.reason === 'uno_penalty';
        if (ev.pid === me && ev.cards) {
          pushLog(`You drew ${ev.cards.map(cardName).join(', ')}`, { ic: 'layers' });
          armedLocal = false;
        } else pushLog(`${who} drew ${ev.count} ${ev.count === 1 ? 'card' : 'cards'}${penalty ? ' (penalty)' : ''}`, { ic: 'layers' });
        audio.play(penalty ? 'penalty' : 'draw');
        if (ev.pid !== me) {
          const from = rectOf(drawBtn.querySelector('.draw-stack'));
          const to = seatCenter(ev.pid);
          const n = backlog > 5 ? 0 : Math.min(ev.count, 4);
          const flights = [];
          for (let i = 0; i < n; i++) flights.push(fly(backEl({ size: 'mini' }), from, to, { duration: 380, delay: i * 90, rotateFrom: 0, rotateTo: 20 }));
          await Promise.all(flights);
        }
        break;
      }
      case 'skip':
        pushLog(ev.pid === me ? 'You were skipped' : `${nameOf(ev.pid)} was skipped`, { ic: 'ban' });
        banner(ev.pid === me ? 'YOU WERE SKIPPED' : `${nameOf(ev.pid).toUpperCase()} SKIPPED`, { kind: 'skip', ic: 'ban' });
        audio.play('skip');
        break;
      case 'reverse':
        pushLog('Direction reversed', { ic: 'repeat' });
        banner('REVERSE', { kind: 'reverse', ic: 'repeat' });
        audio.play('reverse');
        pulse(dirChip);
        break;
      case 'pending':
        pushLog(`Stacked! ${ev.amount} cards pending`, { ic: 'layers', tone: 'warn' });
        banner(`STACK! +${ev.amount}`, { kind: 'pen', ic: 'layers' });
        break;
      case 'uno':
        pushLog(`${nameOf(ev.pid)} called UNO!`, { ic: 'zap', tone: 'hot' });
        banner(`${nameOf(ev.pid).toUpperCase()}: UNO!`, { kind: 'uno', ic: 'zap' });
        audio.play('uno');
        break;
      case 'uno_armed':
        armedLocal = true;
        audio.play('uno');
        renderControls();
        break;
      case 'one_card':
        if (ev.pid !== me) pushLog(`${nameOf(ev.pid)} has one card left…`, { ic: 'hand', tone: 'warn' });
        else { toast('PRESS UNO NOW!', 'error', 2200); }
        break;
      case 'caught':
        pushLog(`${nameOf(ev.target)} was caught by ${nameOf(ev.by)} — draws 2`, { ic: 'zap', tone: 'hot' });
        banner(`${nameOf(ev.target).toUpperCase()} CAUGHT!`, { kind: 'uno', ic: 'zap' });
        audio.play('caught');
        break;
      case 'pass':
        if (!ev.auto) pushLog(`${nameOf(ev.pid)} passed`, { ic: 'arrowRight' });
        break;
      case 'timeout':
        pushLog(`${nameOf(ev.pid)} ran out of time`, { ic: 'timer', tone: 'warn' });
        break;
      case 'reshuffle':
        pushLog('Discard pile reshuffled into the deck', { ic: 'refresh' });
        audio.play('deal');
        break;
      case 'afk':
        pushLog(`${nameOf(ev.pid)} is on autopilot`, { ic: 'bot', tone: 'warn' });
        if (ev.pid === me) toast('YOU TIMED OUT TWICE — AUTOPILOT IS PLAYING FOR YOU. MAKE A MOVE TO TAKE OVER.', 'error', 5200);
        break;
      case 'player_disconnected':
        pushLog(`${nameOf(ev.pid)} lost connection — autopilot`, { ic: 'wifiOff', tone: 'warn' });
        break;
      case 'player_reconnected':
        pushLog(`${nameOf(ev.pid)} reconnected`, { ic: 'check' });
        break;
      case 'player_left':
        pushLog(`${ev.name || nameOf(ev.pid)} left the match`, { ic: 'logout', tone: 'warn' });
        break;
      case 'host_changed':
        pushLog(`${ev.name} is now the host`, { ic: 'crown' });
        break;
      case 'round_end': {
        pushLog(`${nameOf(ev.winnerId)} won round ${ev.round} (+${ev.points})`, { ic: 'trophy', tone: 'good' });
        audio.play('roundWin');
        const r = rectOf(table);
        burst(r.cx, r.cy, '#F9D83D', 40);
        break;
      }
      case 'match_end': {
        pushLog(`${nameOf(ev.winnerId)} won the match!`, { ic: 'trophy', tone: 'good' });
        audio.play(ev.winnerId === me ? 'win' : 'lose');
        break;
      }
      default: break;
    }
    void g;
  }

  function runEvents(events) {
    backlog += events.length;
    const fast = backlog > 8;
    chain = chain.then(async () => {
      for (const ev of events) {
        try { await handleEvent(ev); } catch (err) { console.error(err); }
        backlog = Math.max(0, backlog - 1);
        if (!fast) await new Promise((r) => setTimeout(r, reducedMotion() ? 0 : 70));
      }
    }).catch(console.error);
  }

  // ================================================================= overlays
  const overlayState = { kind: null };
  function renderOverlay() {
    const g = st.game;
    if (g.phase === 'round_over' && g.roundResult) {
      if (overlayState.kind === 'round' && overlayState.round === g.roundResult.round) return;
      overlayState.kind = 'round'; overlayState.round = g.roundResult.round;
      const rr = g.roundResult;
      const rows = [...st.players].sort((a, b) => b.score - a.score).map((p) => {
        const pct = Math.min(100, (p.score / st.settings.winningScore) * 100);
        return h('li', { class: 'ro-row' + (p.id === rr.winnerId ? ' win' : '') },
          avatar(p.avatar, 36),
          h('div', { class: 'grow' },
            h('div', { class: 'row' }, h('span', { class: 'ro-name ellipsis grow' }, p.id === me ? `${p.name} (you)` : p.name), h('b', { class: 'mono' }, String(p.score))),
            h('div', { class: 'bar' }, h('i', { style: { width: pct + '%' } }))));
      });
      const winner = player(rr.winnerId);
      clear(overlay);
      overlay.append(h('div', { class: 'round-card panel' },
        h('div', { class: 'label' }, `Round ${rr.round} complete`),
        h('div', { class: 'ro-winner' }, winner ? avatar(winner.avatar, 64) : null,
          h('div', {}, h('div', { class: 'h1' }, rr.winnerId === me ? 'You win the round!' : `${nameOf(rr.winnerId)} wins the round`), h('div', { class: 'muted' }, `+${rr.points} points`))),
        h('ul', { class: 'ro-list' }, rows),
        h('div', { class: 'ro-next dim' }, 'Next round in ', h('b', { class: 'mono ro-secs' }, ''), ' s · first to ', String(st.settings.winningScore), ' wins')));
      overlay.hidden = false;
      updateOverlayTimer();
    } else if (g.phase === 'finished') {
      if (overlayState.kind === 'finished') return;
      overlayState.kind = 'finished';
      const winner = player(st.results ? st.results.winnerId : null);
      clear(overlay);
      overlay.append(h('div', { class: 'finish-card' }, icon('trophy'), h('div', { class: 'display' }, 'Match finished'), h('div', { class: 'muted' }, winner ? `${winner.id === me ? 'You win' : winner.name + ' wins'}!` : '')));
      overlay.hidden = false;
    } else if (overlayState.kind) {
      overlayState.kind = null;
      overlay.hidden = true;
      clear(overlay);
    }
  }

  function updateOverlayTimer() {
    const t = overlay.querySelector('.ro-secs');
    if (!t) return;
    t.textContent = String(Math.max(0, Math.ceil((st.game.intermissionEndsAt - serverNow()) / 1000)));
  }

  // ================================================================= applying state
  function renderAll({ animate = false, holdPile = 0 } = {}) {
    refreshNames();
    renderHud();
    renderSeats();
    renderPile(holdPile);
    renderHand(animate);
    renderControls();
    renderOverlay();
    renderTime();
  }

  function applyUpdate(msg) {
    const prev = st;
    st = msg.state;
    if (!st.game) return; // routed away by main
    const events = msg.events || [];
    const plays = events.filter((e) => e.type === 'play').length;
    const newRound = !prev.game || prev.game.round !== st.game.round;
    if (plays) {
      pileHeld += plays;
      clearTimeout(pileTimer);
      pileTimer = setTimeout(releasePile, 1800); // safety net if an animation is interrupted
    }
    const drewMine = events.some((e) => e.type === 'draw' && e.pid === me) || newRound;
    renderAll({ animate: drewMine && !reducedMotion(), holdPile: pileHeld });

    // my turn cue
    const g = st.game;
    if (g.phase === 'playing' && g.turnId === me && lastTurnId !== me) {
      audio.play('turn');
      banner('YOUR TURN', { kind: 'turn', ic: 'zap' });
      pulse(myAvatarWrap);
    }
    lastTurnId = g.phase === 'playing' ? g.turnId : null;
    lastPhase = g.phase;
    lastRound = g.round;
    if (events.length) runEvents(events);
  }

  return {
    el,
    mount() {
      setSizes();
      renderAll({ animate: !!(st.game && st.game.discardCount <= 1) && !reducedMotion() });
      lastTurnId = st.game && st.game.phase === 'playing' ? st.game.turnId : null;
      lastPhase = st.game && st.game.phase;
      lastRound = st.game ? st.game.round : 0;
      // seed the log with what happened before this screen opened
      for (const ev of (st.recent || []).slice(-5)) {
        if (ev.type === 'play') pushLog(`${nameOf(ev.pid)} played ${cardName(ev.card)}`, { ic: 'play' });
        else if (ev.type === 'uno') pushLog(`${nameOf(ev.pid)} called UNO!`, { ic: 'zap' });
        else if (ev.type === 'skip') pushLog(`${nameOf(ev.pid)} was skipped`, { ic: 'ban' });
      }
      raf = requestAnimationFrame(frame);
      d.interval(renderTime, 1000);
      d.on(window, 'resize', () => { setSizes(); if (st.game) renderHand(false); });
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(() => { if (st.game) renderHand(false); });
        ro.observe(handScroll);
        d.add(() => ro.disconnect());
      }
      d.on(document, 'visibilitychange', () => { if (!document.hidden && st.game) renderAll({ animate: false }); });
      d.on(handScroll, 'pointerdown', (e) => { if (e.target === handScroll || e.target === handTrack) { selectedId = null; renderHand(false); } });
      setTimeout(() => { if (st.game && st.game.round === 1 && st.game.discardCount <= 1) banner('ROUND 1', { kind: 'round', ic: 'sparkles' }); }, 450);
    },
    onSync(msg) {
      st = msg.state;
      if (!st.game) return;
      pileHeld = 0;
      renderAll({ animate: false });
    },
    onEvents(msg) { applyUpdate(msg); },
    unmount() {
      cancelAnimationFrame(raf);
      clearTimeout(pileTimer);
      d.dispose();
      document.documentElement.style.removeProperty('--hand-cw');
      document.documentElement.style.removeProperty('--pile-cw');
      for (const g of document.querySelectorAll('#flight-layer > *')) g.remove();
    },
  };
}
