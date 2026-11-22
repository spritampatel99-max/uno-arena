// Screen 4 — Victory / results.
import { h, Disposer } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, logoMark } from '../avatars.js';
import { store, subscribe, reducedMotion } from '../store.js';
import { action } from '../net.js';
import { soundControl, toast, confirmModal } from '../ui.js';
import { audio } from '../audio.js';
import { haptic } from '../haptics.js';
import { celebrate } from '../fx.js';

function fmtDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, '0')}`;
}

// Scores tick up from zero so the final numbers land one after another. Skipped with reduced motion.
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

export function createResults(ctx) {
  const d = new Disposer();
  const st = store.state;
  const res = st.results;
  const me = st.me;
  const isHost = st.hostId === me;
  const rows = res ? res.standings : [];
  const winner = rows[0];
  const iWon = !!winner && winner.id === me;

  const medal = (rank) => h('span', { class: `rank r${rank}` }, rank === 1 ? icon('crown') : String(rank));

  const standings = h('ol', { class: 'board', 'aria-label': 'Final scoreboard' },
    h('li', { class: 'board-head', 'aria-hidden': 'true' },
      h('span', {}, 'Rank'), h('span', { class: 'who' }, 'Player'), h('span', {}, 'Score'), h('span', {}, 'Played'), h('span', {}, 'Drawn'), h('span', {}, 'Special')),
    rows.map((r, i) => h('li', { class: 'board-row' + (r.id === me ? ' me' : '') + (r.isWinner ? ' winner' : ''), style: { '--i': i } },
      medal(r.rank),
      h('span', { class: 'who' }, avatar(r.avatar, 44),
        h('span', { class: 'who-name' }, h('b', { class: 'ellipsis' }, r.name), h('small', { class: 'dim' }, [r.id === me ? 'You' : null, r.isBot ? 'Bot' : null, r.left ? 'Left the match' : null].filter(Boolean).join(' · ') || ' '))),
      h('span', { class: 'stat score mono', 'data-label': 'Score' }, String(r.score)),
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

  const el = h('div', { class: 'results' },
    h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, logoMark(), h('span', {}, 'UNO ARENA')),
      h('div', { class: 'tools' }, soundControl())),
    h('div', { class: 'results-wrap' },
      h('section', { class: 'victory' },
        h('div', { class: 'crown-big', 'aria-hidden': 'true' }, icon('crown', { stroke: 1.6 })),
        h('h1', { class: 'display victory-title' }, iWon ? h('span', { class: 'grad-text' }, 'Victory!') : 'Match over'),
        h('p', { class: 'victory-sub muted' }, winner ? (iWon ? `You took the match in ${res.rounds} ${res.rounds === 1 ? 'round' : 'rounds'}. ${reasonText}.` : `${winner.name} wins the match. ${reasonText}.`) : ''),
        winner ? h('div', { class: 'panel winner-card' },
          h('div', { class: 'winner-av' }, avatar(winner.avatar, 112), h('span', { class: 'winner-crown' }, icon('crown'))),
          h('div', { class: 'winner-meta' },
            h('div', { class: 'label' }, 'Champion'),
            h('div', { class: 'h1 ellipsis' }, winner.name),
            h('div', { class: 'winner-score mono' }, h('span', { class: 'js-count', 'data-to': String(winner.score) }, String(winner.score)), h('small', {}, ' pts')),
            h('div', { class: 'winner-chips' },
              h('span', { class: 'chip' }, icon('trophy'), `${winner.roundsWon} ${winner.roundsWon === 1 ? 'round' : 'rounds'} won`),
              h('span', { class: 'chip' }, icon('clock'), fmtDuration(res.durationMs)),
              h('span', { class: 'chip' }, icon('layers'), `${res.rounds} ${res.rounds === 1 ? 'round' : 'rounds'}`)))) : null),
      h('section', { class: 'panel board-card' },
        h('div', { class: 'row card-head' }, h('h2', { class: 'h2 grow' }, 'Final standings')),
        standings),
      acc.length ? h('section', { class: 'accolades', 'aria-label': 'Match highlights' },
        acc.map((a) => h('div', { class: 'accolade panel' }, h('span', { class: 'acc-ic' }, icon(a.ic)), avatar(a.who.avatar, 36),
          h('div', {}, h('div', { class: 'acc-title' }, a.title), h('div', { class: 'dim acc-text' }, `${a.who.name} · ${a.text}`))))) : null,
      h('section', { class: 'result-actions' },
        h('div', { class: 'row gap-3 actions-row' }, btnAgain, btnLobby, btnExit),
        isHost ? null : h('p', { class: 'dim center', style: { fontSize: '13px' } }, 'Waiting for the host to start a rematch or return to the lobby.'))));

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
      const finish = [];
      const wc = el.querySelector('.js-count');
      if (wc) finish.push(countUp(wc, Number(wc.dataset.to), { duration: 1100, delay: 450 }));
      el.querySelectorAll('.board-row .score').forEach((n, i) => finish.push(countUp(n, Number(n.textContent), { duration: 800, delay: 650 + i * 110 })));
      d.add(() => finish.forEach((f) => f()));
      if (iWon) { audio.play('win', { duck: true }); haptic('win'); setTimeout(celebrate, 350); }
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
