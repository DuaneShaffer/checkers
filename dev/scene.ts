import { applyMove, fromFen, initialPosition, legalMoves, moveToString, type Move, type Position, type Side, type Sq } from '../src/engine/index.ts';
import { applyMoveIds, initialIds } from '../src/game/pieceTracker.ts';
import { createBoardViewExt } from '../src/scene/boardView.ts';
import type { Highlights, PieceIds } from '../src/scene/types.ts';
import type { QualityPref } from '../src/scene/quality.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

const view = await createBoardViewExt($('stage'), { testMode: params.has('test') });
view.setBoardSlot($('slot'));
(window as unknown as { __view: typeof view }).__view = view;


interface Ply {
  pos: Position;
  ids: PieceIds;
  move: Move | null;
}

let history: Ply[] = [];
let orientation: Side = 0;
let selected: Sq | null = null;
let prefix: Sq[] = [];
let busy = false;
let seed = 7;

function rand(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}

const current = () => history[history.length - 1];

function reset(pos = initialPosition()): void {
  history = [{ pos, ids: initialIds(pos), move: null }];
  selected = null;
  prefix = [];
  view.setPosition(pos, current().ids);
  refreshHighlights();
}

function candidates(): Move[] {
  const moves = legalMoves(current().pos);
  if (selected === null) return moves;
  return moves.filter((m) => prefix.every((sq, i) => m.path[i] === sq));
}

function refreshHighlights(): void {
  const { pos, move } = current();
  const moves = legalMoves(pos);
  const h: Highlights = { lastMove: move ? [move.from, move.to] : null };
  if (selected === null) {
    h.movable = [...new Set(moves.map((m) => m.from))];
  } else {
    const c = candidates();
    const next = [...new Set(c.map((m) => m.path[prefix.length]).filter((sq) => sq !== undefined))];
    h.selected = selected;
    h.movable = [...new Set(moves.map((m) => m.from))];
    if (c.some((m) => m.captured !== 0)) h.captureTargets = next;
    else h.targets = next;
  }
  view.setHighlights(h);
}

async function commit(m: Move, fromHop = 0): Promise<void> {
  busy = true;
  selected = null;
  prefix = [];
  const prev = current();
  history.push({ pos: applyMove(prev.pos, m), ids: applyMoveIds(prev.ids, m), move: m });
  view.setHighlights({ lastMove: [m.from, m.to] });
  await view.playMove(m, { fromHop });
  busy = false;
  refreshHighlights();
  status(`played ${moveToString(m)}`);
}

async function stepScripted(): Promise<boolean> {
  const moves = legalMoves(current().pos);
  if (moves.length === 0) return false;
  const promoting = moves.filter((m) => m.promotes);
  const pool = promoting.length > 0 ? promoting : moves;
  const longest = Math.max(...pool.map((m) => m.path.length));
  const best = pool.filter((m) => m.path.length === longest);
  await commit(best[Math.floor(rand() * best.length)]);
  return true;
}

view.onSquareTap(async (sq) => {
  status(`tap ${sq === null ? 'none' : sq + 1}`);
  if (busy || sq === null) {
    if (sq === null && prefix.length <= 1) {
      selected = null;
      prefix = [];
      refreshHighlights();
    }
    return;
  }
  const moves = legalMoves(current().pos);
  if (prefix.length <= 1 && moves.some((m) => m.from === sq)) {
    view.cancelPreview();
    selected = selected === sq ? null : sq;
    prefix = selected === null ? [] : [sq];
    refreshHighlights();
    return;
  }
  if (selected === null) return;
  const next = candidates().filter((m) => m.path[prefix.length] === sq);
  if (next.length === 0) return;
  const hopFrom = prefix[prefix.length - 1];
  prefix = [...prefix, sq];
  const done = next.filter((m) => m.path.length === prefix.length);
  if (done.length === 1 && next.length === 1) {
    await commit(done[0], prefix.length > 2 ? prefix.length - 2 : 0);
    return;
  }
  const captured = next[0].captured !== 0 ? jumped(hopFrom, sq) : null;
  refreshHighlights();
  await view.previewHop(hopFrom, sq, captured);
});

function jumped(a: Sq, b: Sq): Sq | null {
  const ra = a >> 2;
  const rb = b >> 2;
  if (Math.abs(ra - rb) !== 2) return null;
  const ca = ra % 2 === 0 ? 2 * (a & 3) + 1 : 2 * (a & 3);
  const cb = rb % 2 === 0 ? 2 * (b & 3) + 1 : 2 * (b & 3);
  const r = (ra + rb) / 2;
  const c = (ca + cb) / 2;
  return r * 4 + (r % 2 === 0 ? (c - 1) / 2 : c / 2);
}

function status(msg: string): void {
  const s = view.stats();
  $('status').textContent = `${msg} · renders ${s.renders} · ${s.animating ? 'animating' : 'idle'} · tier ${s.tier} · ply ${history.length - 1}`;
}
setInterval(() => status($('status').textContent?.split(' · ')[0] ?? ''), 500);

let auto = false;
$('auto').onclick = async () => {
  auto = !auto;
  $('auto').setAttribute('aria-pressed', String(auto));
  while (auto && !busy) {
    if (!(await stepScripted())) break;
    await new Promise((r) => setTimeout(r, 250));
  }
};
$('step').onclick = () => void (!busy && stepScripted());
$('reset').onclick = () => reset();
$('undo').onclick = async () => {
  if (history.length < 2) return;
  history.pop();
  selected = null;
  prefix = [];
  await view.sync(current().pos, current().ids);
  refreshHighlights();
};
$('flip').onclick = () => {
  orientation = (1 - orientation) as Side;
  void view.setOrientation(orientation, true);
};
$('recenter').onclick = () => void view.setOrientation(orientation, true);

const layouts = ['full', 'portrait', 'rails', 'panel'] as const;
const areas: Record<(typeof layouts)[number], string[]> = { full: [], portrait: ['top', 'bottom'], rails: ['left', 'right'], panel: ['side'] };
let layoutIdx = 0;
function applyLayout(): void {
  const l = layouts[layoutIdx];
  $('ui').dataset.layout = l;
  for (const bar of document.querySelectorAll<HTMLElement>('[data-area]')) bar.style.display = areas[l].includes(bar.dataset.area ?? '') ? '' : 'none';
  $('layout').textContent = `Layout: ${l}`;
}
$('layout').onclick = () => {
  layoutIdx = (layoutIdx + 1) % layouts.length;
  applyLayout();
};
if (params.get('layout')) {
  layoutIdx = Math.max(0, layouts.indexOf(params.get('layout') as (typeof layouts)[number]));
  applyLayout();
}
$('outline').onclick = () => {
  const on = $('slot').classList.toggle('outline');
  $('outline').setAttribute('aria-pressed', String(on));
};
$('toggle-controls').onclick = () => $('controls').classList.toggle('hidden');

$('hl').onclick = () => {
  view.setHighlights({
    movable: [8, 9, 10, 11],
    selected: 9,
    targets: [13, 14],
    captureTargets: [17],
    lastMove: [21, 17],
    cursor: 15,
    pending: [22],
  });
};
$('kings').onclick = () => reset(fromFen('B:WK3,K10,22,26,31:BK27,K18,5,9,12'));
$('captures').onclick = () => reset(fromFen('B:W14,15,22,23,30,K7:B10,11,K19'));
let instant = false;
$('instant').onclick = () => {
  instant = !instant;
  view.setInstantAnimations(instant);
  $('instant').setAttribute('aria-pressed', String(instant));
};
const prefs: QualityPref[] = ['auto', 'high', 'low'];
let prefIdx = 0;
$('quality').onclick = () => {
  prefIdx = (prefIdx + 1) % prefs.length;
  view.setQuality(prefs[prefIdx]);
  $('quality').textContent = `Quality: ${prefs[prefIdx]}`;
};

if (params.has('side')) {
  orientation = params.get('side') === '1' ? 1 : 0;
  void view.setOrientation(orientation, false);
}
if (params.has('hidecontrols')) $('controls').classList.add('hidden');
reset(params.get('fen') ? fromFen(params.get('fen') as string) : initialPosition());
if (params.has('hl')) $('hl').click();
status('ready');
