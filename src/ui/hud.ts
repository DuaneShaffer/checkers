import type { Side } from '../engine/types.ts';
import { fullMoveLabel } from '../game/plies.ts';
import type { ConnStatus } from '../net/protocol.ts';
import { h, icon, iconButton, setAttr } from './dom.ts';
import { anyDialogOpen } from './modal.ts';

export interface HudActions {
  home(): void;
  flip(): void;
  toggleSound(): void;
  undo?(): void;
  resign?(): void;
  offerDraw?(): void;
  rematch?(): void;
  showResult(): void;
}

export interface HudModel {
  orientation: Side;
  turn: Side;
  names: Record<Side, string>;
  captured: Record<Side, number>;
  thinking: Side | null;
  over: boolean;
  winner: Side | null;
  status: string;
  chipStatus: string;
  statusTone: 'neutral' | 'alert' | 'over';
  moves: readonly string[];
  firstMover: Side;
  canUndo: boolean;
  canResign: boolean;
  canOfferDraw: boolean;
  canRematch: boolean;
  rematchPending: boolean;
  soundOn: boolean;
  connection?: { status: ConnStatus; label: string };
}

export interface Hud {
  readonly el: HTMLElement;
  readonly slot: HTMLElement;
  update(m: HudModel): void;
  setTitle(title: string, subtitle?: string): void;
  setExtraActions(actions: { label: string; onClick: () => void }[]): void;
}

interface Chip {
  el: HTMLElement;
  swatch: HTMLElement;
  name: HTMLElement;
  count: HTMLElement;
  status: HTMLElement;
}

function playerChip(pos: 'top' | 'bottom'): Chip {
  const swatch = h('span', { class: 'swatch', 'aria-hidden': 'true' });
  const name = h('span', { class: 'pc-name' });
  const count = h('span', { class: 'pc-count' });
  const status = h('span', { class: 'pc-status', 'aria-hidden': 'true' });
  const dots = h('span', { class: 'thinking-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
  const el = h('div', { class: 'player-chip', 'data-pos': pos }, swatch, h('span', { class: 'pc-text' }, name, count), status, dots);
  return { el, swatch, name, count, status };
}

const SIDE_CLASS: Record<Side, string> = { 0: 'crimson', 1: 'ivory' };

export function createHud(opts: { mode: string; title: string; subtitle?: string; actions: HudActions }): Hud {
  const a = opts.actions;
  const title = h('h1', { class: 'hud-title-main' });
  const subtitle = h('p', { class: 'hud-title-sub' });
  const conn = h('span', { class: 'conn-badge', hidden: true });
  const top = playerChip('top');
  const bottom = playerChip('bottom');
  const status = h('p', { class: 'hud-status', 'aria-hidden': 'true' });
  const resultButton = h('button', { type: 'button', class: 'btn', hidden: true, onClick: () => a.showResult() }, 'Result');
  const moveList = h('ol', { class: 'move-list', 'aria-label': 'Moves', 'data-empty': 'No moves yet' });
  const movesPanel = h('div', { class: 'moves-panel' }, h('h2', { class: 'panel-label' }, 'Moves'), moveList);

  const undo = a.undo ? iconButton('undo', 'Undo', () => a.undo?.()) : null;
  const flip = iconButton('flip', 'Flip board', () => a.flip());
  const resign = a.resign ? iconButton('flag', 'Resign', () => a.resign?.()) : null;
  const draw = a.offerDraw ? iconButton('handshake', 'Offer draw', () => a.offerDraw?.()) : null;
  const sound = iconButton('sound', 'Sound', () => a.toggleSound());
  const rematch = a.rematch ? h('button', { type: 'button', class: 'btn btn-primary hud-rematch', hidden: true, onClick: () => a.rematch?.() }, 'Play again') : null;
  const extras = h('div', { class: 'hud-extra' });
  const actions = h('div', { class: 'hud-actions', role: 'toolbar', 'aria-label': 'Game actions' }, undo, flip, draw, resign, sound);

  const slot = h('div', {
    class: 'board-slot',
    tabindex: 0,
    role: 'application',
    'aria-roledescription': 'checkers board',
    'aria-label': 'Board. Use arrow keys to move the cursor, Enter to pick a piece or square, Escape to cancel.',
  });

  const el = h('section', { class: 'screen game-screen', 'data-mode': opts.mode },
    h('div', { class: 'hud-a' },
      h('div', { class: 'hud-bar' },
        iconButton('home', 'Home', () => a.home(), { class: 'icon-btn hud-home' }),
        h('div', { class: 'hud-title' }, title, subtitle),
        conn,
      ),
      top.el,
      h('div', { class: 'hud-status-row' }, status),
      movesPanel,
    ),
    slot,
    h('div', { class: 'hud-b' },
      bottom.el,
      h('div', { class: 'hud-controls' }, rematch, resultButton, extras, actions),
    ),
  );

  actions.addEventListener('click', (e) => {
    if (e.detail > 0 && !anyDialogOpen()) slot.focus({ preventScroll: true });
  });

  let lastMovesKey = '';

  const setTitle = (t: string, sub?: string) => {
    title.textContent = t;
    subtitle.textContent = sub ?? '';
    subtitle.hidden = !sub;
  };
  setTitle(opts.title, opts.subtitle);

  function paintChip(chip: Chip, side: Side, m: HudModel) {
    chip.el.dataset.side = SIDE_CLASS[side];
    chip.swatch.className = `swatch swatch-${SIDE_CLASS[side]}`;
    chip.name.textContent = m.names[side];
    const n = m.captured[side];
    chip.count.textContent = n > 0 ? `×${n}` : '';
    setAttr(chip.count, 'aria-label', `${n} captured`);
    setAttr(chip.el, 'data-active', !m.over && m.turn === side);
    setAttr(chip.el, 'data-thinking', m.thinking === side);
    setAttr(chip.el, 'data-winner', m.over && m.winner === side);
    const statusSide = m.over ? m.orientation : m.turn;
    chip.status.textContent = side === statusSide ? m.chipStatus : '';
    chip.status.dataset.tone = m.statusTone;
  }

  function paintMoves(m: HudModel) {
    const key = `${m.firstMover}|${m.moves.join(' ')}`;
    if (key === lastMovesKey) return;
    lastMovesKey = key;
    const items: HTMLElement[] = [];
    const start = m.firstMover === 1 ? -1 : 0;
    for (let i = start; i < m.moves.length; i += 2) {
      const first = i >= 0 ? m.moves[i] : '…';
      const second = m.moves[i + 1];
      const n = fullMoveLabel(m.firstMover, Math.max(i, 0)).number;
      items.push(h('li', {}, h('span', { class: 'ml-n' }, `${n}.`), h('span', {}, first), h('span', {}, second ?? '')));
    }
    moveList.replaceChildren(...items);
    moveList.scrollTop = moveList.scrollHeight;
  }

  return {
    el,
    slot,
    setTitle,
    setExtraActions(list) {
      extras.replaceChildren(...list.map((x) => h('button', { type: 'button', class: 'btn', onClick: x.onClick }, x.label)));
    },
    update(m) {
      const bottomSide = m.orientation;
      paintChip(top, (1 - bottomSide) as Side, m);
      paintChip(bottom, bottomSide, m);
      status.textContent = m.status;
      status.dataset.tone = m.statusTone;
      resultButton.hidden = !m.over;
      paintMoves(m);
      if (undo) undo.disabled = !m.canUndo;
      if (resign) resign.hidden = !m.canResign;
      if (draw) draw.hidden = !m.canOfferDraw;
      if (rematch) {
        rematch.hidden = !m.canRematch;
        rematch.disabled = m.rematchPending;
        rematch.textContent = m.rematchPending ? 'Rematch offered' : 'Play again';
      }
      sound.replaceChildren(icon(m.soundOn ? 'sound' : 'mute'));
      setAttr(sound, 'aria-label', m.soundOn ? 'Mute sound' : 'Unmute sound');
      setAttr(sound, 'title', m.soundOn ? 'Mute sound' : 'Unmute sound');
      setAttr(sound, 'aria-pressed', String(!m.soundOn));
      if (m.connection) {
        conn.hidden = false;
        conn.textContent = m.connection.label;
        conn.dataset.status = m.connection.status;
      } else {
        conn.hidden = true;
      }
    },
  };
}
