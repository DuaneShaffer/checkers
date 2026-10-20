import '../styles/lab.css';
import type { AppContext, RouteParams, Screen, ScreenFactory } from '../app/contracts.ts';
import { fromFen, INITIAL_FEN } from '../engine/position.ts';
import { Game } from '../engine/game.ts';
import type { GameRecord, GenerationSummary, TrainingManifest } from '../shared/formats.ts';
import {
  LabDataError,
  defaultGeneration,
  findGeneration,
  labData,
  nextGeneration,
  playerName,
  previousGeneration,
  type LabData,
} from './data.ts';
import { button, compactNumber, formatHours, h, icon, signed } from './dom.ts';
import { createEloChart, type EloChart } from './eloChart.ts';
import { DEFAULT_THINK_MS, THINK_PRESETS, liveRoute, matchupPicker } from './livePicker.ts';
import { miniBoard } from './miniBoard.ts';
import { kindText, mountReplay, reasonText, replayRoute, resultText } from './replayView.ts';
import { wdlBars } from './wdlBars.ts';

export type LabRoute =
  | { kind: 'overview'; gen: number | null }
  | { kind: 'gen'; gen: number }
  | { kind: 'replay'; gen: number; id: string; ply: number }
  | { kind: 'live'; a: number | null; b: number | null; thinkMs: number; preset: { a?: number; b?: number } };

const toGen = (s: string | null | undefined): number | null => (s && /^\d{1,6}$/.test(s) ? Number(s) : null);

export function parseLabRoute(params: RouteParams): LabRoute {
  const path = params.path[0] === 'lab' ? params.path.slice(1) : params.path.slice();
  if (path[0] === 'g') path.shift();
  const q = params.query;
  if (path[0] === 'live') {
    const ms = Number(q.get('ms'));
    const thinkMs = THINK_PRESETS.some((t) => t.ms === ms) ? ms : DEFAULT_THINK_MS;
    return {
      kind: 'live',
      a: toGen(path[1]),
      b: toGen(path[2]),
      thinkMs,
      preset: { a: toGen(path[1]) ?? toGen(q.get('a')) ?? undefined, b: toGen(path[2]) ?? toGen(q.get('b')) ?? undefined },
    };
  }
  const gen = toGen(path[0]);
  if (gen === null) return { kind: 'overview', gen: toGen(q.get('gen')) };
  if (path[1]) {
    const ply = Number(q.get('ply'));
    return { kind: 'replay', gen, id: path[1], ply: Number.isFinite(ply) && ply >= 0 ? Math.trunc(ply) : 0 };
  }
  return { kind: 'gen', gen };
}

export const labScreen: ScreenFactory = (ctx, params) => createLabScreen(ctx, params, labData());

export function createLabScreen(ctx: AppContext, params: RouteParams, data: LabData): Screen {
  const route = parseLabRoute(params);
  const root = h('div', { class: `lab-screen lab-route-${route.kind}`, 'data-testid': 'lab-screen' });
  ctx.root.append(root);
  const cleanups: (() => void)[] = [];
  let disposed = false;

  const onDispose = (fn: () => void) => {
    if (disposed) fn();
    else cleanups.push(fn);
  };

  async function load(refresh = false): Promise<void> {
    root.replaceChildren(loadingView());
    let manifest: TrainingManifest;
    try {
      manifest = await data.manifest({ refresh });
    } catch (e) {
      if (disposed) return;
      if (e instanceof LabDataError && e.kind === 'missing') {
        render(emptyView(ctx));
        return;
      }
      render(errorView(ctx, e, () => void load(true)));
      return;
    }
    if (disposed) return;
    if (manifest.generations.length === 0) {
      render(emptyView(ctx));
      return;
    }
    try {
      await show(manifest);
    } catch (e) {
      if (!disposed) render(errorView(ctx, e, () => void load(true)));
    }
  }

  function render(el: HTMLElement): void {
    root.replaceChildren(el);
    el.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
  }

  async function show(manifest: TrainingManifest): Promise<void> {
    if (route.kind === 'overview') {
      render(overviewView(ctx, manifest, route.gen, onDispose));
      document.title = 'Training Lab · Checkers';
    } else if (route.kind === 'gen') {
      const g = findGeneration(manifest, route.gen);
      if (!g) throw new LabDataError('missing', 'manifest.json', `Generation ${route.gen} isn't in this training run`);
      render(generationView(ctx, data, manifest, g, () => disposed));
      document.title = `Gen ${g.gen} · Training Lab`;
    } else if (route.kind === 'replay') {
      const rec = await data.game(route.gen, route.id);
      if (disposed) return;
      root.replaceChildren();
      const handle = mountReplay(root, { ctx, data, manifest, gen: route.gen, record: rec, initialPly: route.ply });
      onDispose(() => handle.dispose());
      root.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
      document.title = `Gen ${route.gen} replay · Training Lab`;
    } else {
      await showLive(manifest, route);
    }
  }

  async function showLive(manifest: TrainingManifest, r: Extract<LabRoute, { kind: 'live' }>): Promise<void> {
    const hasNet = (g: number | null): g is number => g !== null && manifest.generations.some((x) => x.gen === g && x.net);
    const showPicker = (notice?: string) => {
      const view = livePickerPage(ctx, manifest, r);
      if (notice) view.querySelector('.lab-page')?.append(h('p', { class: 'lab-notice', role: 'status' }, notice));
      render(view);
    };
    if (r.a === null || r.b === null) {
      showPicker();
      return;
    }
    if (!hasNet(r.a) || !hasNet(r.b)) {
      showPicker('One of those generations has no published network. Pick another pair.');
      return;
    }
    root.replaceChildren();
    root.classList.add('lab-live-running');
    try {
      const { startLiveMatch } = await import('./liveMatch.ts');
      if (disposed) return;
      const screen = await startLiveMatch({ ctx, data, manifest, a: r.a, b: r.b, thinkMs: r.thinkMs, cancelled: () => disposed });
      if (screen) onDispose(() => screen.dispose());
    } catch (e) {
      if (disposed) return;
      root.classList.remove('lab-live-running');
      showPicker(`Couldn't start the live match: ${(e as Error).message ?? e}`);
    }
  }

  void load();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const fn of cleanups.splice(0)) {
        try { fn(); } catch { /* keep disposing */ }
      }
      root.remove();
    },
  };
}

function header(title: string, opts: { back?: { label: string; hash: string; ctx: AppContext }; sub?: Node | string; extra?: Node | null } = {}): HTMLElement {
  return h('header', { class: 'lab-header' },
    opts.back ? button([icon('back'), h('span', {}, opts.back.label)], () => opts.back!.ctx.navigate(opts.back!.hash), { class: 'lab-back' }) : null,
    h('div', { class: 'lab-header-text' },
      h('h1', { class: 'lab-title', tabindex: -1 }, title),
      opts.sub ? h('p', { class: 'lab-sub' }, opts.sub) : null),
    opts.extra ?? null);
}

function page(...children: (Node | null)[]): HTMLElement {
  return h('div', { class: 'lab-scroll' }, h('div', { class: 'lab-page' }, ...children));
}

function loadingView(): HTMLElement {
  return page(h('div', { class: 'lab-loading', role: 'status' }, h('span', { class: 'lab-spinner', 'aria-hidden': 'true' }), 'Loading training data…'));
}

function emptyView(ctx: AppContext): HTMLElement {
  return page(
    header('Training Lab', { back: { label: 'Home', hash: '#/', ctx } }),
    h('section', { class: 'lab-card lab-empty', 'data-testid': 'lab-empty' },
      emptyIllustration(),
      h('h2', { class: 'lab-empty-title' }, "Training hasn't run yet"),
      h('p', {}, 'When the self-play trainer publishes its first generation, this is where you will watch the engine teach itself: its rating climbing generation by generation, and replays of the games it learned from.'),
      h('p', { class: 'lab-muted' }, 'Until then, the AI plays with a hand-written heuristic.'),
      button('Back to the table', () => ctx.navigate('#/'), { class: 'lab-btn lab-btn-primary' })));
}

function emptyIllustration(): SVGSVGElement {
  const svg = miniBoard(fromFen(INITIAL_FEN), { orientation: 0 });
  svg.classList.add('lab-empty-board');
  return svg;
}

function errorView(ctx: AppContext, e: unknown, retry: () => void): HTMLElement {
  const missing = e instanceof LabDataError && e.kind === 'missing';
  const message = e instanceof LabDataError
    ? e.kind === 'network' ? "Couldn't reach the training data. Check your connection and try again." : e.message
    : `Something went wrong: ${(e as Error)?.message ?? e}`;
  return page(
    header('Training Lab', { back: { label: missing ? 'Lab' : 'Home', hash: missing ? '#/lab' : '#/', ctx } }),
    h('section', { class: 'lab-card lab-error', role: 'alert', 'data-testid': 'lab-error' },
      h('h2', { class: 'lab-card-title' }, missing ? 'Not found' : "Couldn't load the Lab"),
      h('p', {}, message),
      h('div', { class: 'lab-actions' },
        missing ? button('Open the Lab overview', () => ctx.navigate('#/lab'), { class: 'lab-btn lab-btn-primary' })
          : button('Try again', retry, { class: 'lab-btn lab-btn-primary' }))));
}

function statTile(label: string, value: string, note?: string): HTMLElement {
  return h('div', { class: 'lab-stat' },
    h('div', { class: 'lab-stat-label' }, label),
    h('div', { class: 'lab-stat-value' }, value),
    note ? h('div', { class: 'lab-stat-note' }, note) : null);
}

function updatedText(m: TrainingManifest): string {
  if (!m.updated) return '';
  const d = new Date(m.updated);
  if (Number.isNaN(d.getTime())) return '';
  return `Updated ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function overviewView(ctx: AppContext, m: TrainingManifest, initialGen: number | null, onDispose: (fn: () => void) => void): HTMLElement {
  const gens = m.generations;
  const last = gens.at(-1)!;
  const champion = m.champion !== null ? findGeneration(m, m.champion) : undefined;
  let selected = initialGen !== null && findGeneration(m, initialGen) ? initialGen : (defaultGeneration(m) ?? last.gen);

  const stats = h('div', { class: 'lab-stats', 'data-testid': 'lab-stats' },
    statTile('Generations', String(gens.length), `gen ${gens[0].gen}–${last.gen}`),
    statTile('Games played', compactNumber(m.totalGames || last.games), 'self-play'),
    statTile('Training time', formatHours(m.hours || last.hours)),
    statTile('Champion Elo', champion ? String(Math.round(champion.elo)) : '–', champion ? `gen ${champion.gen}` : 'not chosen yet'));

  const genPanel = h('section', { class: 'lab-card gen-panel', 'aria-live': 'polite', 'data-testid': 'gen-panel' });
  let chart: EloChart | null = null;
  const pickerLabel = h('output', { class: 'picker-value lab-num', for: 'gen-range' });
  const range = h('input', { id: 'gen-range', type: 'range', min: 0, max: gens.length - 1, step: 1, class: 'gen-range', 'aria-label': 'Generation', 'data-testid': 'gen-range' });
  const prevBtn = button(icon('chevronLeft'), () => selectIndex(indexOf(selected) - 1), { class: 'lab-icon-btn', 'aria-label': 'Previous generation' });
  const nextBtn = button(icon('chevronRight'), () => selectIndex(indexOf(selected) + 1), { class: 'lab-icon-btn', 'aria-label': 'Next generation' });
  range.addEventListener('input', () => selectIndex(Number(range.value)));
  const picker = h('div', { class: 'gen-picker', role: 'group', 'aria-label': 'Choose a generation' }, prevBtn, range, nextBtn, pickerLabel);

  function indexOf(gen: number): number {
    return Math.max(0, gens.findIndex((g) => g.gen === gen));
  }

  function selectIndex(i: number): void {
    const g = gens[Math.max(0, Math.min(gens.length - 1, i))];
    select(g.gen);
  }

  function select(gen: number): void {
    selected = gen;
    chart?.setSelected(gen);
    renderGenPanel();
    const hash = `#/lab?gen=${gen}`;
    if (location.hash !== hash) history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
  }

  function renderGenPanel(): void {
    const g = findGeneration(m, selected)!;
    const i = indexOf(selected);
    range.value = String(i);
    range.setAttribute('aria-valuetext', `Generation ${g.gen}`);
    pickerLabel.textContent = `Gen ${g.gen}`;
    prevBtn.disabled = i === 0;
    nextBtn.disabled = i === gens.length - 1;
    genPanel.replaceChildren(
      picker,
      genSummary(m, g),
      wdlBars(m, g),
      h('div', { class: 'lab-actions' },
        button([h('span', {}, `Open generation ${g.gen}`), icon('chevronRight')], () => ctx.navigate(`#/lab/${g.gen}`), { class: 'lab-btn lab-btn-primary', 'data-testid': 'open-gen' })));
  }

  chart = createEloChart({ manifest: m, selected, onSelect: (gen) => select(gen), onOpen: (gen) => ctx.navigate(`#/lab/${gen}`) });
  onDispose(() => chart?.dispose());
  renderGenPanel();

  const chartCard = h('section', { class: 'lab-card chart-card', 'aria-labelledby': 'elo-title' },
    h('div', { class: 'lab-card-head' },
      h('h2', { id: 'elo-title', class: 'lab-card-title' }, 'Elo by generation'),
      h('p', { class: 'lab-muted' }, 'Shaded band shows the rating uncertainty. Dashed lines are fixed opponents; Heuristic d4 is pinned at 1000.')),
    chart.el,
    eloTable(m));

  return page(
    header('Training Lab', { back: { label: 'Home', hash: '#/', ctx }, sub: [m.run ? `Run ${m.run}` : '', updatedText(m)].filter(Boolean).join(' · ') || 'Watch the engine teach itself' }),
    stats,
    h('div', { class: 'lab-grid' }, chartCard, genPanel),
    matchupPicker(m, {}, (a, b, ms) => ctx.navigate(liveRoute(a, b, ms))));
}

function eloTable(m: TrainingManifest): HTMLElement {
  const rows = m.generations.map((g) => h('tr', {},
    h('th', { scope: 'row' }, String(g.gen)),
    h('td', {}, String(Math.round(g.elo))),
    h('td', {}, `±${Math.round(g.eloErr)}`),
    h('td', {}, compactNumber(g.games))));
  return h('details', { class: 'elo-table' },
    h('summary', {}, 'Show as table'),
    h('div', { class: 'elo-table-scroll' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Gen'), h('th', { scope: 'col' }, 'Elo'), h('th', { scope: 'col' }, 'Error'), h('th', { scope: 'col' }, 'Games'))),
        h('tbody', {}, ...rows))));
}

function genSummary(m: TrainingManifest, g: GenerationSummary, opts: { showName?: boolean } = {}): HTMLElement {
  const prev = previousGeneration(m, g.gen);
  const delta = prev ? g.elo - prev.elo : null;
  return h('div', { class: 'gen-summary' },
    h('div', { class: 'gen-summary-head' },
      opts.showName === false ? null : h('h2', { class: 'gen-name' }, `Gen ${g.gen}`, g.gen === m.champion ? h('span', { class: 'lab-badge' }, 'champion') : null),
      h('div', { class: 'gen-elo' },
        h('span', { class: 'gen-elo-value' }, String(Math.round(g.elo))),
        h('span', { class: 'gen-elo-err' }, `± ${Math.round(g.eloErr)} Elo`),
        delta !== null ? h('span', { class: `gen-delta ${delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : ''}` }, `${signed(delta)} vs gen ${prev!.gen}`) : null)),
    h('dl', { class: 'gen-facts' },
      fact('Games trained', compactNumber(g.games)),
      fact('Hours', formatHours(g.hours)),
      fact('Search depth', g.depth ? String(g.depth) : '–'),
      fact('Avg length', g.avgPlies ? `${Math.round(g.avgPlies)} plies` : '–'),
      fact('Decisive', `${Math.round(g.decisive * 100)}%`)));
}

function fact(label: string, value: string): HTMLElement {
  return h('div', { class: 'lab-fact' }, h('dt', {}, label), h('dd', {}, value));
}

type GameFilter = 'all' | 'selfplay' | 'gauntlet' | 'decisive';
const FILTERS: { id: GameFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'selfplay', label: 'Self-play' },
  { id: 'gauntlet', label: 'Gauntlet' },
  { id: 'decisive', label: 'Decisive' },
];

function generationView(ctx: AppContext, data: LabData, m: TrainingManifest, g: GenerationSummary, isDisposed: () => boolean): HTMLElement {
  const prev = previousGeneration(m, g.gen);
  const next = nextGeneration(m, g.gen);
  const nav = h('div', { class: 'gen-nav' },
    button(icon('chevronLeft'), () => prev && ctx.navigate(`#/lab/${prev.gen}`), { class: 'lab-icon-btn', 'aria-label': prev ? `Generation ${prev.gen}` : 'No earlier generation', disabled: !prev }),
    button(icon('chevronRight'), () => next && ctx.navigate(`#/lab/${next.gen}`), { class: 'lab-icon-btn', 'aria-label': next ? `Generation ${next.gen}` : 'No later generation', disabled: !next }));

  const gamesCard = h('section', { class: 'lab-card games-card', 'aria-labelledby': 'games-title' });
  const list = h('ul', { class: 'game-list', 'data-testid': 'game-list' });
  const status = h('p', { class: 'lab-muted', role: 'status' }, 'Loading games…');
  let filter: GameFilter = 'all';
  let games: GameRecord[] = [];
  const chips = FILTERS.map((f) => button(f.label, () => { filter = f.id; renderList(); }, { class: 'lab-chip', 'aria-pressed': f.id === filter ? 'true' : 'false', 'data-filter': f.id }));
  gamesCard.append(
    h('div', { class: 'lab-card-head' },
      h('h2', { id: 'games-title', class: 'lab-card-title' }, 'Sampled games'),
      h('p', { class: 'lab-muted' }, 'A few games kept from this generation: self-play against itself, and gauntlet games against fixed opponents.')),
    h('div', { class: 'lab-chip-row', role: 'group', 'aria-label': 'Filter games' }, ...chips),
    status,
    list);

  function renderList(): void {
    for (const c of chips) c.setAttribute('aria-pressed', c.dataset.filter === filter ? 'true' : 'false');
    const shown = games.filter((r) => filter === 'all' || (filter === 'decisive' ? r.result !== '1/2-1/2' : r.kind === filter));
    list.replaceChildren(...shown.map((r) => gameCard(m, g.gen, r)));
    status.textContent = shown.length ? '' : games.length ? 'No games match this filter.' : 'No games were sampled for this generation.';
    status.hidden = shown.length > 0;
  }

  if (!g.replay) {
    status.textContent = 'No games were sampled for this generation.';
  } else {
    data.genFile(g.gen).then((file) => {
      if (isDisposed()) return;
      games = file.games;
      renderList();
    }, (e) => {
      if (isDisposed()) return;
      status.textContent = e instanceof LabDataError && e.kind === 'network' ? "Couldn't load this generation's games. Check your connection." : `Couldn't load games: ${(e as Error).message}`;
    });
  }

  const liveOpponent = g.net ? [...m.generations].reverse().find((x) => x.net && x.gen < g.gen) ?? m.generations.find((x) => x.net && x.gen > g.gen) : undefined;
  const actions = h('div', { class: 'lab-actions' });
  if (g.net && liveOpponent) {
    actions.append(button(`Watch live vs gen ${liveOpponent.gen}`, () => ctx.navigate(liveRoute(g.gen, liveOpponent.gen)), { class: 'lab-btn' }));
  }

  return page(
    header(`Generation ${g.gen}`, { back: { label: 'Lab', hash: `#/lab?gen=${g.gen}`, ctx }, sub: g.gen === m.champion ? 'Current champion' : undefined, extra: nav }),
    h('div', { class: 'lab-grid lab-grid-detail' },
      h('section', { class: 'lab-card gen-panel', 'data-testid': 'gen-detail', 'aria-label': `Generation ${g.gen} summary` }, genSummary(m, g, { showName: false }), wdlBars(m, g), actions.childElementCount ? actions : null),
      gamesCard));
}

function gameCard(m: TrainingManifest, gen: number, r: GameRecord): HTMLElement {
  let finalBoard: SVGSVGElement;
  try {
    finalBoard = miniBoard(Game.fromMoves(r.moves, { startFen: r.startFen }).position, { label: 'Final position' });
  } catch {
    finalBoard = miniBoard(fromFen(r.startFen ?? INITIAL_FEN));
  }
  const resultCls = r.result === '1-0' ? 'res-crimson' : r.result === '0-1' ? 'res-ivory' : 'res-draw';
  const opening = r.moves.slice(0, 3).join(' ');
  return h('li', {},
    h('a', { class: 'game-card', href: replayRoute(gen, r.id), 'data-testid': 'game-card', 'data-game-id': r.id },
      finalBoard,
      h('div', { class: 'game-card-body' },
        h('div', { class: 'game-card-top' },
          h('span', { class: 'lab-tag' }, kindText(r)),
          h('span', { class: `lab-result ${resultCls}` }, resultText(r))),
        h('div', { class: 'game-players' },
          h('span', { class: 'lab-swatch lab-swatch-crimson', 'aria-hidden': 'true' }), playerName(m, r.black),
          h('span', { class: 'lab-vs' }, 'vs'),
          h('span', { class: 'lab-swatch lab-swatch-ivory', 'aria-hidden': 'true' }), playerName(m, r.white)),
        h('div', { class: 'game-meta lab-num' }, `${r.moves.length} plies · ${reasonText(r)}`),
        opening ? h('div', { class: 'game-opening lab-num' }, opening) : null),
      h('span', { class: 'game-watch', 'aria-hidden': 'true' }, icon('play'))));
}

function livePickerPage(ctx: AppContext, m: TrainingManifest, r: Extract<LabRoute, { kind: 'live' }>): HTMLElement {
  return page(
    header('Live match', { back: { label: 'Lab', hash: '#/lab', ctx }, sub: 'Two generations, one board, no script' }),
    matchupPicker(m, { ...r.preset, thinkMs: r.thinkMs }, (a, b, ms) => ctx.navigate(liveRoute(a, b, ms))));
}
