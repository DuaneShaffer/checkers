import type { AppContext } from '../app/contracts.ts';
import type { GameRecord, TrainingManifest } from '../shared/formats.ts';
import type { BoardView } from '../scene/types.ts';
import { generationsWithReplays, playerName, type LabData } from './data.ts';
import { button, h, icon, s } from './dom.ts';
import { miniBoard } from './miniBoard.ts';
import {
  buildTimeline,
  clampPly,
  evalToWinProbability,
  fullMoveLabel,
  type ReplayTimeline,
} from './replayTimeline.ts';

export const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const;
const AUTOPLAY_GAP_MS = 650;
const SNAP_MS = 120;
const URL_THROTTLE_MS = 300;

export interface ReplayParams {
  ctx: AppContext;
  data: LabData;
  manifest: TrainingManifest;
  gen: number;
  record: GameRecord;
  initialPly: number;
}

interface ReplayBoard {
  show(ply: number): void;
  animate(ply: number, speed: number): Promise<void>;
  snap(ply: number): Promise<void>;
  dispose(): void;
}

export function replayRoute(gen: number, id: string, ply?: number): string {
  const base = `#/lab/${gen}/${encodeURIComponent(id)}`;
  return ply === undefined ? base : `${base}?ply=${ply}`;
}

export function resultText(rec: GameRecord): string {
  if (rec.result === '1-0') return 'Crimson wins';
  if (rec.result === '0-1') return 'Ivory wins';
  return 'Draw';
}

const REASON_TEXT: Record<GameRecord['reason'], string> = {
  'no-moves': 'no moves left',
  repetition: 'threefold repetition',
  'no-progress': '80-ply rule',
  'max-plies': 'ply cap',
  resign: 'resignation',
  agreement: 'agreement',
};

export function reasonText(rec: GameRecord): string {
  return REASON_TEXT[rec.reason];
}

export function kindText(rec: GameRecord): string {
  return rec.kind === 'selfplay' ? 'Self-play' : 'Gauntlet';
}

function boardAdapter(view: BoardView, t: ReplayTimeline, slot: HTMLElement): ReplayBoard {
  const lastMove = (ply: number) => {
    const p = t.plies[ply - 1];
    return p ? ([p.move.from, p.move.to] as const) : null;
  };
  view.setBoardSlot(slot);
  view.setVisible(true);
  void view.setOrientation(0, false);
  return {
    show(ply) {
      view.setPosition(t.positions[ply], t.ids[ply]);
      view.setHighlights({ lastMove: lastMove(ply) });
    },
    async animate(ply, speed) {
      view.setHighlights({});
      await view.playMove(t.plies[ply - 1].move, { speed });
      view.setHighlights({ lastMove: lastMove(ply) });
    },
    async snap(ply) {
      view.setHighlights({ lastMove: lastMove(ply) });
      await view.sync(t.positions[ply], t.ids[ply], { duration: SNAP_MS });
    },
    dispose() {
      view.setHighlights({});
      view.setBoardSlot(null);
    },
  };
}

function svgAdapter(t: ReplayTimeline, slot: HTMLElement): ReplayBoard {
  const holder = h('div', { class: 'replay-fallback-board', 'data-testid': 'replay-fallback-board' });
  slot.append(holder);
  const draw = (ply: number) => {
    const p = t.plies[ply - 1];
    holder.replaceChildren(miniBoard(t.positions[ply], { lastMove: p ? [p.move.from, p.move.to] : null, label: `Board after ply ${ply}` }));
  };
  return {
    show: draw,
    animate: async (ply) => draw(ply),
    snap: async (ply) => draw(ply),
    dispose: () => holder.remove(),
  };
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el?.tagName) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function mountReplay(host: HTMLElement, p: ReplayParams): { dispose(): void } {
  const { ctx, manifest, gen, record } = p;
  const t = buildTimeline(record);
  const L = t.length;
  let ply = clampPly(t, p.initialPly);
  let speed = 1;
  let playing = false;
  let animating = false;
  let opId = 0;
  let playSession = 0;
  let disposed = false;

  const slot = h('div', { class: 'board-slot replay-slot', 'data-testid': 'replay-board-slot' });
  const stage = h('div', { class: 'replay-stage' }, slot);
  const evalFill = h('span', { class: 'eval-fill' });
  const evalLabel = h('span', { class: 'eval-label lab-num', 'aria-hidden': 'true' });
  const evalBar = h('span', { class: 'eval-bar', role: 'meter', 'aria-label': 'Evaluation: Crimson win chance', 'aria-valuemin': 0, 'aria-valuemax': 100, 'data-testid': 'replay-eval' }, evalFill);

  const back = button([icon('back'), h('span', {}, `Gen ${gen}`)], () => ctx.navigate(`#/lab/${gen}`), { class: 'lab-back', 'aria-label': `Back to generation ${gen}` });
  const topbar = h('header', { class: 'replay-top' },
    back,
    h('div', { class: 'replay-title' },
      h('h1', {}, `${kindText(record)} · Gen ${gen}`),
      h('p', { class: 'replay-sub' }, `${resultText(record)} · ${reasonText(record)} · ${L} plies`)));

  const players = h('div', { class: `replay-players${t.evals.length ? ' has-eval' : ''}` },
    h('span', { class: 'lab-player' }, h('span', { class: 'lab-swatch lab-swatch-crimson', 'aria-hidden': 'true' }), playerName(manifest, record.black)),
    t.evals.length ? h('span', { class: 'eval-wrap' }, evalBar, evalLabel) : h('span', { class: 'lab-vs' }, 'vs'),
    h('span', { class: 'lab-player lab-player-end' }, playerName(manifest, record.white), h('span', { class: 'lab-swatch lab-swatch-ivory', 'aria-hidden': 'true' })));

  const readout = h('div', { class: 'replay-readout', 'aria-hidden': 'true' },
    h('span', { class: 'lab-num', 'data-testid': 'replay-ply' }),
    h('span', { class: 'replay-current lab-num' }));
  const plyText = readout.children[0] as HTMLElement;
  const currentText = readout.children[1] as HTMLElement;

  const scrub = h('input', { type: 'range', min: 0, max: L, step: 1, value: ply, class: 'replay-scrub', 'aria-label': 'Ply', 'data-testid': 'replay-scrub' });
  const scrubWrap = h('div', { class: 'replay-scrub-wrap' }, sparkline(t), scrub);

  const btnFirst = button(icon('first'), () => { pause(); snapTo(0); }, { class: 'lab-tbtn', 'aria-label': 'First position' });
  const btnBack = button(icon('prev'), () => stepBack(), { class: 'lab-tbtn', 'aria-label': 'Step back', 'data-testid': 'replay-back' });
  const btnPlay = button(icon('play'), () => togglePlay(), { class: 'lab-tbtn lab-tbtn-primary', 'aria-label': 'Play', 'data-testid': 'replay-play' });
  const btnFwd = button(icon('next'), () => stepForward(), { class: 'lab-tbtn', 'aria-label': 'Step forward', 'data-testid': 'replay-forward' });
  const btnLast = button(icon('last'), () => { pause(); snapTo(L); }, { class: 'lab-tbtn', 'aria-label': 'Last position' });
  const transport = h('div', { class: 'replay-transport', role: 'group', 'aria-label': 'Playback' }, btnFirst, btnBack, btnPlay, btnFwd, btnLast);

  const speedButtons = REPLAY_SPEEDS.map((v) => button(`${v}×`, () => setSpeed(v), { class: 'lab-seg', 'aria-pressed': v === speed ? 'true' : 'false', 'data-speed': v }));
  const speedRow = h('div', { class: 'replay-speed lab-seg-group', role: 'group', 'aria-label': 'Playback speed' }, h('span', { class: 'lab-seg-label' }, 'Speed'), ...speedButtons);
  const speedCycle = button(`${speed}×`, () => setSpeed(REPLAY_SPEEDS[(REPLAY_SPEEDS.indexOf(speed as typeof REPLAY_SPEEDS[number]) + 1) % REPLAY_SPEEDS.length]), { class: 'lab-seg speed-cycle', 'aria-label': `Playback speed ${speed}×` });

  const moveButtons: HTMLButtonElement[] = [];
  const moveList = h('ol', { class: 'lab-moves', 'aria-label': 'Moves', 'data-testid': 'replay-moves' });
  buildMoveList();

  const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const extras = h('div', { class: 'replay-extras' });
  const panel = h('section', { class: 'replay-panel', 'aria-label': 'Replay controls' },
    players, h('div', { class: 'replay-row' }, readout, speedRow, speedCycle), scrubWrap, transport, h('div', { class: 'lab-moves-wrap' }, moveList), extras, live);
  const root = h('div', { class: 'lab-replay', 'data-testid': 'lab-replay' }, topbar, stage, panel);
  host.append(root);

  let board: ReplayBoard = { show() {}, animate: async () => {}, snap: async () => {}, dispose() {} };
  updateUi(false);
  void buildExtras();
  void attachBoard();

  async function attachBoard(): Promise<void> {
    let ready: ReplayBoard;
    try {
      const view = await ctx.board();
      if (disposed) return;
      ready = boardAdapter(view, t, slot);
    } catch {
      if (disposed) return;
      ready = svgAdapter(t, slot);
    }
    board = ready;
    board.show(ply);
    root.dataset.board = 'ready';
  }

  function buildMoveList(): void {
    const startTurn = t.positions[0].turn;
    let row: HTMLLIElement | null = null;
    t.plies.forEach((pl, i) => {
      const { number, side } = fullMoveLabel(startTurn, i);
      if (!row || side === 0 || i === 0) {
        row = h('li', { class: 'lab-move-row' }, h('span', { class: 'lab-move-no lab-num' }, `${number}.`));
        if (side === 1) row.append(h('span', { class: 'lab-move lab-move-gap', 'aria-hidden': 'true' }, '…'));
        moveList.append(row);
      }
      const marks = (pl.captures ? ' is-capture' : '') + (pl.crowned ? ' is-crown' : '');
      const b = button(pl.notation, () => { pause(); snapTo(i + 1); }, { class: `lab-move lab-num${marks}`, 'data-ply': i + 1, 'aria-label': `Ply ${i + 1}: ${pl.side === 0 ? 'Crimson' : 'Ivory'} ${pl.notation}` });
      moveButtons.push(b);
      row.append(b);
    });
  }

  function setPly(n: number, announce: boolean): void {
    ply = n;
    updateUi(announce);
    scheduleUrl();
  }

  function updateUi(announce: boolean): void {
    plyText.textContent = `Ply ${ply} / ${L}`;
    const pl = t.plies[ply - 1];
    currentText.textContent = pl ? `${pl.side === 0 ? 'Crimson' : 'Ivory'} ${pl.notation}` : 'Start';
    if (Number(scrub.value) !== ply) scrub.value = String(ply);
    scrub.setAttribute('aria-valuetext', `Ply ${ply} of ${L}${pl ? `, ${pl.notation}` : ''}`);
    btnBack.disabled = ply === 0;
    btnFirst.disabled = ply === 0;
    btnFwd.disabled = ply === L;
    btnLast.disabled = ply === L;
    btnPlay.replaceChildren(icon(playing ? 'pause' : 'play'));
    btnPlay.setAttribute('aria-label', playing ? 'Pause' : ply === L ? 'Replay from start' : 'Play');
    for (const b of moveButtons) b.classList.remove('is-current');
    const cur = moveButtons[ply - 1];
    if (cur) {
      cur.classList.add('is-current');
      keepVisible(cur);
    }
    if (t.evals.length) {
      const e = t.evals[ply];
      const pct = Math.round(evalToWinProbability(e) * 100);
      evalFill.style.width = `${pct}%`;
      evalLabel.textContent = e > 0 ? `+${e}` : String(e);
      evalBar.setAttribute('aria-valuenow', String(pct));
      evalBar.setAttribute('aria-valuetext', `Crimson ${pct}% to win`);
    }
    if (announce) live.textContent = pl ? `Ply ${ply}: ${pl.side === 0 ? 'Crimson' : 'Ivory'} ${pl.notation}` : 'Start position';
  }

  function keepVisible(el: HTMLElement): void {
    const box = moveList.parentElement;
    if (!box) return;
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.top < b.top || r.bottom > b.bottom) box.scrollTop += r.top - b.top - (b.height - r.height) / 2;
    if (r.left < b.left || r.right > b.right) box.scrollLeft += r.left - b.left - (b.width - r.width) / 2;
  }

  function revealCurrent(): void {
    const cur = moveButtons[ply - 1];
    if (cur) keepVisible(cur);
  }

  let urlTimer: ReturnType<typeof setTimeout> | null = null;
  let lastUrlWrite = 0;
  function scheduleUrl(): void {
    if (urlTimer) return;
    const wait = Math.max(0, URL_THROTTLE_MS - (Date.now() - lastUrlWrite));
    urlTimer = setTimeout(writeUrl, wait);
  }

  function writeUrl(): void {
    urlTimer = null;
    if (disposed) return;
    lastUrlWrite = Date.now();
    const hash = replayRoute(gen, record.id, ply);
    if (location.hash !== hash) history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
  }

  async function animateTo(next: number): Promise<boolean> {
    const id = ++opId;
    animating = true;
    setPly(next, !playing);
    try {
      await board.animate(next, speed);
    } catch {
      board.show(next);
    } finally {
      if (id === opId) animating = false;
    }
    return id === opId && !disposed;
  }

  function snapTo(target: number): void {
    const n = clampPly(t, target);
    ++opId;
    animating = false;
    setPly(n, true);
    board.snap(n).catch(() => board.show(n));
  }

  function stepForward(): void {
    pause();
    if (ply >= L) return;
    if (animating) snapTo(ply + 1);
    else void animateTo(ply + 1);
  }

  function stepBack(): void {
    pause();
    if (ply > 0) snapTo(ply - 1);
  }

  function pause(): void {
    if (!playing) return;
    playing = false;
    playSession++;
    updateUi(false);
  }

  async function play(): Promise<void> {
    const restart = ply >= L;
    if (restart) snapTo(0);
    playing = true;
    const session = ++playSession;
    updateUi(false);
    if (restart || animating) await sleep(SNAP_MS + 30);
    while (playing && session === playSession && ply < L && !disposed) {
      const ok = await animateTo(ply + 1);
      if (!ok || session !== playSession) return;
      if (ply < L) await sleep(AUTOPLAY_GAP_MS / speed);
    }
    if (session === playSession && !disposed) {
      playing = false;
      updateUi(false);
    }
  }

  function togglePlay(): void {
    if (playing) pause();
    else void play();
  }

  function setSpeed(v: number): void {
    speed = v;
    for (const b of speedButtons) b.setAttribute('aria-pressed', Number(b.dataset.speed) === v ? 'true' : 'false');
    speedCycle.textContent = `${v}×`;
    speedCycle.setAttribute('aria-label', `Playback speed ${v}×`);
  }

  scrub.addEventListener('input', () => {
    pause();
    snapTo(Number(scrub.value));
  });

  function onKey(ev: KeyboardEvent): void {
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey || isTypingTarget(ev.target)) return;
    const onButton = (ev.target as HTMLElement | null)?.tagName === 'BUTTON';
    switch (ev.key) {
      case ' ':
      case 'k':
        if (onButton && ev.key === ' ') return;
        togglePlay();
        break;
      case 'ArrowRight':
      case ']':
        stepForward();
        break;
      case 'ArrowLeft':
      case '[':
        stepBack();
        break;
      case 'Home':
        pause();
        snapTo(0);
        break;
      case 'End':
        pause();
        snapTo(L);
        break;
      default:
        return;
    }
    ev.preventDefault();
  }
  window.addEventListener('keydown', onKey);
  const movesObserver = new ResizeObserver(() => revealCurrent());
  movesObserver.observe(moveList.parentElement!);

  async function buildExtras(): Promise<void> {
    const next = await nextGenerationGame(p).catch(() => null);
    if (disposed) return;
    queueMicrotask(revealCurrent);
    if (next) {
      extras.append(button([h('span', {}, `Same game, gen ${next.gen}`), icon('chevronRight')], () => ctx.navigate(replayRoute(next.gen, next.id)), { class: 'lab-btn lab-btn-ghost', 'data-testid': 'replay-next-gen' }));
    }
    if (record.moves.length >= 3) {
      const compare = button('Same opening, other gens', () => {
        compare.disabled = true;
        compare.textContent = 'Searching…';
        void findSameOpening(p).then((hits) => {
          if (disposed) return;
          compare.remove();
          extras.append(sameOpeningList(hits));
        }).catch(() => {
          compare.disabled = false;
          compare.textContent = 'Same opening, other gens';
          ctx.toast("Couldn't search other generations", 'error');
        });
      }, { class: 'lab-btn lab-btn-ghost' });
      extras.append(compare);
    }
  }

  function sameOpeningList(hits: { gen: number; id: string; rec: GameRecord }[]): HTMLElement {
    const opening = record.moves.slice(0, 3).join(' ');
    if (!hits.length) return h('p', { class: 'lab-muted' }, `No other sampled game opens ${opening}.`);
    return h('div', { class: 'same-opening' },
      h('p', { class: 'lab-muted' }, `Opening ${opening} in other generations`),
      h('div', { class: 'lab-chip-row' }, ...hits.map((hit) =>
        button(`Gen ${hit.gen} · ${resultText(hit.rec)}`, () => ctx.navigate(replayRoute(hit.gen, hit.id)), { class: 'lab-chip' }))));
  }

  return {
    dispose() {
      disposed = true;
      playing = false;
      playSession++;
      opId++;
      if (urlTimer) clearTimeout(urlTimer);
      window.removeEventListener('keydown', onKey);
      movesObserver.disconnect();
      board.dispose();
      root.remove();
    },
  };
}

function sparkline(t: ReplayTimeline): SVGSVGElement {
  const L = Math.max(1, t.length);
  const svg = s('svg', { class: 'scrub-spark', viewBox: `0 0 ${L} 100`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  svg.append(s('line', { x1: 0, x2: L, y1: 50, y2: 50, class: 'spark-mid' }));
  if (t.evals.length) {
    const pts = t.evals.map((e, i) => `${i},${(100 - evalToWinProbability(e) * 100).toFixed(1)}`).join(' ');
    svg.append(s('polyline', { points: pts, class: 'spark-line' }));
  }
  t.plies.forEach((pl, i) => {
    if (pl.crowned) svg.append(s('line', { x1: i + 1, x2: i + 1, y1: 0, y2: 18, class: 'spark-crown' }));
    else if (pl.captures) svg.append(s('line', { x1: i + 1, x2: i + 1, y1: 82, y2: 100, class: 'spark-capture' }));
  });
  return svg;
}

async function nextGenerationGame(p: ReplayParams): Promise<{ gen: number; id: string } | null> {
  const candidates = generationsWithReplays(p.manifest).filter((g) => g.gen > p.gen);
  const target = candidates[0];
  if (!target) return null;
  const [cur, next] = await Promise.all([p.data.genFile(p.gen), p.data.genFile(target.gen)]);
  const sameKind = (games: GameRecord[]) => games.filter((g) => g.kind === p.record.kind);
  const idx = Math.max(0, sameKind(cur.games).findIndex((g) => g.id === p.record.id));
  const pool = sameKind(next.games);
  const pick = pool[Math.min(idx, pool.length - 1)] ?? next.games[0];
  return pick ? { gen: target.gen, id: pick.id } : null;
}

const MAX_OPENING_SCAN = 24;

async function findSameOpening(p: ReplayParams): Promise<{ gen: number; id: string; rec: GameRecord }[]> {
  const opening = p.record.moves.slice(0, 3);
  const gens = generationsWithReplays(p.manifest).filter((g) => g.gen !== p.gen);
  const stride = Math.max(1, Math.ceil(gens.length / MAX_OPENING_SCAN));
  const picked = gens.filter((_, i) => i % stride === 0 || i === gens.length - 1);
  const files = await Promise.allSettled(picked.map((g) => p.data.genFile(g.gen)));
  const hits: { gen: number; id: string; rec: GameRecord }[] = [];
  for (const f of files) {
    if (f.status !== 'fulfilled') continue;
    const rec = f.value.games.find((g) => g.moves.length >= 3 && opening.every((m, i) => g.moves[i] === m) && (g.startFen ?? '') === (p.record.startFen ?? ''));
    if (rec) hits.push({ gen: f.value.gen, id: rec.id, rec });
  }
  return hits.sort((a, b) => a.gen - b.gen);
}
