// Screen 4 — Victory / results, laid out as a match dashboard:
// podium, summary figures, score-race chart, per-stat bars, full scoreboard.
// Every number comes from the server's `results` payload (see buildResults in server/rooms.js).
import { h, s, Disposer } from '../dom.js';
import { icon } from '../icons.js';
import { chatButton } from '../chat.js';
import { avatar, logoMark } from '../avatars.js';
import { store, subscribe, reducedMotion } from '../store.js';
import { action } from '../net.js';
import { soundControl, toast, confirmModal } from '../ui.js';
import { audio } from '../audio.js';
import { haptic } from '../haptics.js';
import { celebrate } from '../fx.js';
import { uiScale } from '../scale.js';

// A player keeps one colour for the whole screen (podium, chart line, bars, scoreboard), picked by seat, never by rank.
// Order chosen so neighbours stay apart for colour-blind readers (checked with the dataviz validator).
const SEAT_COLOR = ['#287BFF', '#FF414B', '#F9D83D', '#27C978'];
const seatColor = (r) => SEAT_COLOR[(r.seat || 0) % SEAT_COLOR.length];
const SURFACE = '#171E31';

function fmtDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, '0')}`;
}

// Numbers tick up from zero so the final figures land one after another. Skipped with reduced motion.
function countUp(node, to, { duration = 900, delay = 0 } = {}) {
  if (reducedMotion() || !Number.isFinite(to) || to <= 0) return () => {};
  node.textContent = '0';
  let raf = 0;
  const timer = setTimeout(() => {
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / duration);
      node.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }, delay);
  return () => { clearTimeout(timer); cancelAnimationFrame(raf); node.textContent = String(to); };
}

function accolades(rows) {
  if (rows.length < 2) return [];
  const out = [];
  const best = (key, title, ic, text) => {
    const max = Math.max(...rows.map((r) => r[key]));
    const leaders = rows.filter((r) => r[key] === max);
    if (max > 0 && leaders.length === 1) out.push({ title, ic, who: leaders[0], text: `${max} ${text}` });
  };
  best('cardsPlayed', 'Card shark', 'layers', 'cards played');
  best('specialCards', 'Chaos agent', 'sparkles', 'special cards');
  best('unoCalls', 'Quick on the UNO', 'zap', 'UNO calls');
  best('cardsDrawn', 'Deck collector', 'hand', 'cards drawn');
  return out.slice(0, 3);
}

const ordinal = (n) => ({ 1: '1st', 2: '2nd', 3: '3rd' }[n] || `${n}th`);

/** Clean axis steps: at most four intervals, round numbers. */
function niceAxis(max) {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
  const step = steps.find((st) => Math.ceil(Math.max(max, 1) / st) <= 4) || 5000;
  return { step, top: step * Math.max(1, Math.ceil(max / step)) };
}

/** Score race: cumulative score after every round. Drawn at the real pixel size so text stays crisp at any interface scale. */
function scoreRace(rows, timeline, me) {
  const rounds = timeline.length;
  const series = rows.map((r) => ({ r, color: seatColor(r), pts: [0, ...timeline.map((t) => t.scores[r.id] || 0)] }));
  const maxScore = Math.max(1, ...series.flatMap((x) => x.pts));
  const axis = niceAxis(maxScore);

  const host = h('div', { class: 'race-plot' });
  const tip = h('div', { class: 'race-tip', hidden: true, role: 'presentation' });
  host.append(tip);
  let svg = null;
  let lastW = 0;
  let lastK = 0;
  let animated = false;

  const summary = `Score race over ${rounds} ${rounds === 1 ? 'round' : 'rounds'}. ` + rows.map((r) => `${r.name} finished on ${r.score}`).join(', ') + '.';

  function draw() {
    const k = uiScale();
    const W = Math.max(260, Math.round(host.clientWidth));
    if (svg && W === lastW && k === lastK) return;
    lastW = W; lastK = k;
    const H = Math.round(Math.min(300 * k, Math.max(190 * k, W * 0.46)));
    const m = { l: 40 * k, r: 46 * k, t: 14 * k, b: 30 * k };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const x = (i) => m.l + (rounds === 0 ? 0 : (iw * i) / rounds);
    const y = (v) => m.t + ih - (ih * v) / axis.top;
    const fs = 12 * k;

    const kids = [];
    // gridlines: hairline, solid, one step off the surface
    for (let v = 0; v <= axis.top; v += axis.step) {
      kids.push(s('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: '#293650', 'stroke-opacity': v === 0 ? 1 : 0.7, 'stroke-width': Math.max(1, k) }));
      kids.push(s('text', { x: m.l - 8 * k, y: y(v) + fs * 0.35, 'text-anchor': 'end', fill: '#6F7B91', 'font-size': fs, 'font-family': 'Inter, sans-serif' }, String(v)));
    }
    // x labels: thin out when there are many rounds
    const every = rounds > 12 ? Math.ceil(rounds / 8) : 1;
    for (let i = 0; i <= rounds; i += 1) {
      if (i % every !== 0 && i !== rounds) continue;
      kids.push(s('text', { x: x(i), y: H - m.b + 19 * k, 'text-anchor': i === 0 ? 'start' : i === rounds ? 'end' : 'middle', fill: '#6F7B91', 'font-size': fs, 'font-family': 'Inter, sans-serif' }, i === 0 ? 'Start' : `R${i}`));
    }
    // lines (winner drawn last so it sits on top)
    const drawOrder = [...series].sort((a, b) => b.r.rank - a.r.rank);
    drawOrder.forEach((sr, n) => {
      const d = sr.pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
      kids.push(s('path', { d, fill: 'none', stroke: sr.color, 'stroke-width': 2 * k, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', pathLength: 1, class: 'race-line', style: `--n:${n}` }));
    });
    // end dots with a surface ring + the final value, nudged apart when scores tie
    const ends = series.map((sr) => ({ sr, y: y(sr.pts[sr.pts.length - 1]) })).sort((a, b) => a.y - b.y);
    const gap = 15 * k;
    for (let i = 1; i < ends.length; i += 1) if (ends[i].y - ends[i - 1].y < gap) ends[i].y = ends[i - 1].y + gap;
    ends.forEach(({ sr, y: ly }, n) => {
      const last = sr.pts[sr.pts.length - 1];
      kids.push(s('circle', { cx: x(rounds), cy: y(last), r: 4.5 * k, fill: sr.color, stroke: SURFACE, 'stroke-width': 2 * k, class: 'race-dot', style: `--n:${n}` }));
      kids.push(s('text', { x: x(rounds) + 11 * k, y: ly + fs * 0.35, fill: '#fff', 'font-size': fs * 1.08, 'font-weight': 600, 'font-family': 'Inter, sans-serif', class: 'race-end', style: `--n:${n}` }, String(last)));
    });
    // hover layer
    const cross = s('line', { y1: m.t, y2: m.t + ih, stroke: '#A7B1C5', 'stroke-opacity': 0.55, 'stroke-width': Math.max(1, k), visibility: 'hidden' });
    const hoverDots = series.map((sr) => s('circle', { r: 4.5 * k, fill: sr.color, stroke: SURFACE, 'stroke-width': 2 * k, visibility: 'hidden' }));
    const hit = s('rect', { x: m.l - 10 * k, y: m.t, width: iw + 20 * k, height: ih + 6 * k, fill: 'transparent' });
    kids.push(cross, ...hoverDots, hit);

    const next = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': summary, class: animated || reducedMotion() ? 'race-svg still' : 'race-svg' }, ...kids);
    if (svg) svg.replaceWith(next); else host.prepend(next);
    svg = next;
    animated = true;

    const hide = () => { cross.setAttribute('visibility', 'hidden'); hoverDots.forEach((c) => c.setAttribute('visibility', 'hidden')); tip.hidden = true; };
    const show = (clientX) => {
      const box = svg.getBoundingClientRect();
      const px = ((clientX - box.left) / box.width) * W;
      const i = rounds === 0 ? 0 : Math.max(0, Math.min(rounds, Math.round(((px - m.l) / iw) * rounds)));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      series.forEach((sr, n) => { hoverDots[n].setAttribute('cx', x(i)); hoverDots[n].setAttribute('cy', y(sr.pts[i])); hoverDots[n].setAttribute('visibility', 'visible'); });
      tip.replaceChildren(
        h('div', { class: 'tip-head' }, i === 0 ? 'Start of match' : `After round ${i}`),
        ...[...series].sort((a, b) => b.pts[i] - a.pts[i]).map((sr) => h('div', { class: 'tip-row' }, h('i', { class: 'sw', style: { background: sr.color } }), h('span', { class: 'ellipsis' }, sr.r.id === me ? `${sr.r.name} (you)` : sr.r.name), h('b', { class: 'mono' }, String(sr.pts[i])))));
      tip.hidden = false;
      const tw = tip.offsetWidth;
      const cx = (x(i) / W) * box.width;
      tip.style.left = `${cx > box.width / 2 ? cx - tw - 14 * k : cx + 14 * k}px`;
      tip.style.top = `${m.t * (box.height / H)}px`;
    };
    hit.addEventListener('pointermove', (e) => show(e.clientX));
    hit.addEventListener('pointerdown', (e) => show(e.clientX));
    hit.addEventListener('pointerleave', hide);
  }

  return { host, draw };
}

export function createResults(ctx) {
  const d = new Disposer();
  const st = store.state;
  const res = st.results;
  const me = st.me;
  const isHost = st.hostId === me;
  const rows = res ? res.standings : [];
  const timeline = res && Array.isArray(res.timeline) ? res.timeline : [];
  const winner = rows[0];
  const iWon = !!winner && winner.id === me;
  const sum = (key) => rows.reduce((a, r) => a + (r[key] || 0), 0);

  // ---- podium: DOM stays in rank order (reading order); CSS `order` puts 1st in the middle
  const POD_ORDER = { 1: 2, 2: 1, 3: 3, 4: 4 };
  const POD_H = { 1: 1, 2: 0.74, 3: 0.54, 4: 0.38 };
  const podium = h('ol', { class: 'podium', 'aria-label': 'Podium' }, rows.map((r) => {
    const note = r.rank === 1 ? 'Champion' : r.id === me ? 'You' : r.isBot ? 'Bot' : r.left ? 'Left the match' : '';
    return h('li', { class: `pod r${r.rank}` + (r.id === me ? ' me' : ''), style: { '--pc': seatColor(r), '--k': POD_H[r.rank] || 0.34, order: POD_ORDER[r.rank] || r.rank } },
      h('div', { class: 'pod-who' },
        r.rank === 1 ? h('span', { class: 'pod-crown', 'aria-hidden': 'true' }, icon('crown')) : null,
        avatar(r.avatar, r.rank === 1 ? 104 : 80, '', r.frame),
        h('b', { class: 'pod-name ellipsis' }, r.name),
        h('small', { class: 'pod-note' }, note || ' ')),
      h('div', { class: 'pod-score mono' }, h('span', { class: 'js-count', 'data-to': String(r.score) }, String(r.score)), h('small', {}, ' pts')),
      h('div', { class: 'pod-block' }, h('span', { class: 'sr-only' }, `${ordinal(r.rank)} place`), h('span', { class: 'pod-num', 'aria-hidden': 'true' }, String(r.rank))));
  }));

  // ---- summary figures (all from the payload)
  const tile = (ic, label, value, { count } = {}) => h('div', { class: 'tile' },
    h('span', { class: 'tile-ic', 'aria-hidden': 'true' }, icon(ic)),
    h('div', { class: 'tile-body' },
      h('span', { class: 'tile-label' }, label),
      h('b', { class: 'tile-val mono' + (count ? ' js-tile' : ''), 'data-to': count ? String(value) : null }, String(value))));
  const summary = h('section', { class: 'panel summary', 'aria-label': 'Match summary' },
    tile('clock', 'Match time', res ? fmtDuration(res.durationMs) : '0:00'),
    tile('layers', 'Rounds', res ? res.rounds : 0, { count: true }),
    tile('trophy', 'Target score', res ? res.winningScore : 0, { count: true }),
    tile('hand', 'Cards played', sum('cardsPlayed'), { count: true }),
    tile('zap', 'UNO calls', sum('unoCalls'), { count: true }),
    tile('alert', 'Penalty cards', sum('penalties'), { count: true }));

  // ---- score race
  const race = timeline.length ? scoreRace(rows, timeline, me) : null;
  const legend = h('ul', { class: 'legend', 'aria-label': 'Players' }, [...rows].sort((a, b) => (a.seat || 0) - (b.seat || 0)).map((r) =>
    h('li', {}, h('i', { class: 'sw', style: { background: seatColor(r) } }), h('span', { class: 'ellipsis' }, r.id === me ? `${r.name} (you)` : r.name))));
  const racePanel = race ? h('section', { class: 'panel race', 'aria-label': 'Score race' },
    h('div', { class: 'panel-head' }, h('h2', { class: 'h2' }, 'Score race'), h('span', { class: 'dim panel-sub' }, 'Total after each round')),
    legend, race.host) : null;

  // ---- per-stat bars: one thin bar per player, sorted high to low, value at the tip
  const METRICS = [
    { key: 'score', title: 'Points', ic: 'trophy' },
    { key: 'cardsPlayed', title: 'Cards played', ic: 'layers' },
    { key: 'cardsDrawn', title: 'Cards drawn', ic: 'hand' },
    { key: 'specialCards', title: 'Special cards', ic: 'sparkles' },
  ];
  const metricPanel = (mt) => {
    const sorted = [...rows].sort((a, b) => (b[mt.key] - a[mt.key]) || (a.rank - b.rank));
    const max = Math.max(1, ...rows.map((r) => r[mt.key]));
    return h('section', { class: 'panel metric', 'aria-label': mt.title },
      h('div', { class: 'metric-head' }, h('span', { class: 'metric-ic', 'aria-hidden': 'true' }, icon(mt.ic)), h('h3', { class: 'h2' }, mt.title)),
      h('ul', { class: 'bars' }, sorted.map((r, i) => h('li', { class: 'bar-row' },
        h('span', { class: 'bar-who' }, avatar(r.avatar, 30, '', r.frame), h('span', { class: 'ellipsis' }, r.name)),
        h('span', { class: 'bar-track' },
          h('span', { class: 'bar-line', style: { '--w': `${(r[mt.key] / max) * 100}%`, '--pc': seatColor(r), '--i': i } },
            h('span', { class: 'bar-fill' }),
            h('b', { class: 'bar-val mono js-bar', 'data-to': String(r[mt.key]) }, String(r[mt.key]))))))));
  };

  // ---- full scoreboard (also the text alternative to the charts)
  const standings = h('ol', { class: 'board', 'aria-label': 'Final scoreboard' },
    h('li', { class: 'board-head', 'aria-hidden': 'true' },
      h('span', {}, 'Rank'), h('span', { class: 'who' }, 'Player'), h('span', {}, 'Score'), h('span', {}, 'Rounds won'), h('span', {}, 'Played'), h('span', {}, 'Drawn'), h('span', {}, 'Special')),
    rows.map((r, i) => h('li', { class: 'board-row' + (r.id === me ? ' me' : '') + (r.isWinner ? ' winner' : ''), style: { '--i': i, '--pc': seatColor(r) } },
      h('span', { class: `rank r${r.rank}` }, r.rank === 1 ? icon('crown') : String(r.rank)),
      h('span', { class: 'who' }, avatar(r.avatar, 44, '', r.frame),
        h('span', { class: 'who-name' }, h('b', { class: 'ellipsis' }, h('i', { class: 'sw', style: { background: seatColor(r) } }), r.name), h('small', { class: 'dim' }, [r.id === me ? 'You' : null, r.isBot ? 'Bot' : null, r.left ? 'Left the match' : null].filter(Boolean).join(' · ') || ' '))),
      h('span', { class: 'stat score mono', 'data-label': 'Score' }, String(r.score)),
      h('span', { class: 'stat mono', 'data-label': 'Won' }, String(r.roundsWon)),
      h('span', { class: 'stat mono', 'data-label': 'Played' }, String(r.cardsPlayed)),
      h('span', { class: 'stat mono', 'data-label': 'Drawn' }, String(r.cardsDrawn)),
      h('span', { class: 'stat mono', 'data-label': 'Special' }, String(r.specialCards)))));

  const acc = accolades(rows);

  const btnAgain = h('button', { class: 'btn lg green', disabled: !isHost, title: isHost ? '' : 'Only the host can start a rematch', onclick: async () => {
    audio.play('click');
    btnAgain.disabled = true;
    const r = await action('rematch');
    if (!r.ok) { toast(r.message, 'error'); btnAgain.disabled = false; audio.play('error'); }
  } }, icon('refresh'), 'Play again');
  const btnLobby = h('button', { class: 'btn lg ghost', disabled: !isHost, title: isHost ? '' : 'Only the host can return the room to the lobby', onclick: async () => {
    audio.play('click');
    const r = await action('to_lobby');
    if (!r.ok) { toast(r.message, 'error'); audio.play('error'); }
  } }, icon('home'), 'Return to lobby');
  const btnExit = h('button', { class: 'btn lg danger', onclick: async () => {
    const ok = await confirmModal({ title: 'Exit the room?', body: isHost && st.players.length > 1 ? 'You are the host — the host role will pass to another player.' : 'You will leave this room and go back to the start screen.', confirmLabel: 'Exit room', danger: true });
    if (ok) ctx.leave();
  } }, icon('logout'), 'Exit room');

  const reasonText = res && res.reason === 'forfeit' ? 'Everyone else left the match.' : `First to ${res ? res.winningScore : ''} points`;

  const el = h('div', { class: 'results' + (iWon ? ' won' : '') },
    h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, logoMark(), h('span', {}, 'UNO ARENA')),
      h('div', { class: 'tools' }, soundControl(), chatButton())),
    h('div', { class: 'results-wrap' },
      h('section', { class: 'victory' },
        h('h1', { class: 'display victory-title' }, iWon ? h('span', { class: 'grad-text' }, 'Victory!') : 'Match over'),
        h('p', { class: 'victory-sub muted' }, winner ? (iWon ? `You took the match in ${res.rounds} ${res.rounds === 1 ? 'round' : 'rounds'}. ${reasonText}.` : `${winner.name} wins the match. ${reasonText}.`) : '')),
      h('div', { class: 'dash' },
        h('section', { class: 'panel stage', 'aria-label': 'Final podium' }, podium),
        summary,
        racePanel),
      h('div', { class: 'metrics' }, METRICS.map(metricPanel)),
      h('section', { class: 'panel board-card' },
        h('div', { class: 'row card-head' }, h('h2', { class: 'h2 grow' }, 'Final standings')),
        standings),
      acc.length ? h('section', { class: 'accolades', 'aria-label': 'Match highlights' },
        acc.map((a) => h('div', { class: 'accolade panel' }, h('span', { class: 'acc-ic' }, icon(a.ic)), avatar(a.who.avatar, 36, '', a.who.frame),
          h('div', {}, h('div', { class: 'acc-title' }, a.title), h('div', { class: 'dim acc-text' }, `${a.who.name} · ${a.text}`))))) : null,
      h('section', { class: 'result-actions' },
        h('div', { class: 'row gap-3 actions-row' }, btnAgain, btnLobby, btnExit),
        isHost ? null : h('p', { class: 'dim center', style: { fontSize: 'calc(13px * var(--s))' } }, 'Waiting for the host to start a rematch or return to the lobby.'))));

  return {
    el,
    mount() {
      d.add(subscribe((keys) => {
        if (!keys.includes('state') || !store.state) return;
        const host = store.state.hostId === me;
        btnAgain.disabled = !host; btnLobby.disabled = !host;
        btnAgain.title = host ? '' : 'Only the host can start a rematch';
        btnLobby.title = host ? '' : 'Only the host can return the room to the lobby';
      }));

      // the chart is drawn at its real size, so wait for layout; redraw when the width (or interface scale) changes
      if (race) {
        race.draw();
        if (typeof ResizeObserver === 'function') {
          const ro = new ResizeObserver(() => race.draw());
          ro.observe(race.host);
          d.add(() => ro.disconnect());
        } else {
          const onResize = () => race.draw();
          window.addEventListener('resize', onResize);
          d.add(() => window.removeEventListener('resize', onResize));
        }
      }

      // count-ups follow the podium: 4th place first, champion last
      const finish = [];
      const POD_DELAY = { 4: 650, 3: 800, 2: 950, 1: 1250 };
      el.querySelectorAll('.pod').forEach((pod) => {
        const n = pod.querySelector('.js-count');
        const rank = Number(pod.className.match(/\br(\d)\b/)?.[1] || 4);
        if (n) finish.push(countUp(n, Number(n.dataset.to), { duration: 1000, delay: POD_DELAY[rank] || 800 }));
      });
      el.querySelectorAll('.js-tile').forEach((n, i) => finish.push(countUp(n, Number(n.dataset.to), { duration: 800, delay: 500 + i * 90 })));
      el.querySelectorAll('.js-bar').forEach((n, i) => finish.push(countUp(n, Number(n.dataset.to), { duration: 800, delay: 900 + (i % 4) * 90 })));
      el.querySelectorAll('.board-row .score').forEach((n, i) => finish.push(countUp(n, Number(n.textContent), { duration: 800, delay: 1100 + i * 110 })));
      d.add(() => finish.forEach((f) => f()));

      if (iWon) { audio.play('win', { duck: true }); haptic('win'); setTimeout(celebrate, 1350); }
      else if (winner) { audio.play('lose', { duck: true }); }
    },
    onEvents(msg) {
      for (const ev of msg.events || []) {
        if (ev.type === 'host_changed') toast(ev.pid === store.state.me ? 'YOU ARE NOW THE HOST' : `${ev.name} is now the host`, 'info');
        else if (ev.type === 'player_left') toast(`${ev.name} left the room`, 'info');
      }
    },
    unmount() { d.dispose(); },
  };
}
