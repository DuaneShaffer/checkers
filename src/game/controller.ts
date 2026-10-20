import { Game } from '../engine/game.ts';
import { moveToString } from '../engine/notation.ts';
import { fromFen, pieceAt, toFen } from '../engine/position.ts';
import type { GameResult, GameStatus, Move, Position, Side, Sq } from '../engine/types.ts';
import type { BoardView, Highlights, PieceIds } from '../scene/types.ts';
import { SIDE_NAMES } from './announcer.ts';
import type { DriverSnapshot, GameDriver } from './driver.ts';
import { type Direction, startCursor, stepCursor } from './keyboard.ts';
import { applyMoveIds, idsAfterMoves } from './pieceTracker.ts';
import {
  type IllegalReason,
  type SelectionState,
  cancelSelection,
  createSelection,
  isCaptureState,
  selectionView,
  tapSquare,
} from './selection.ts';

export interface ControllerView {
  snapshot: DriverSnapshot;
  position: Position;
  status: GameStatus;
  canMove: boolean;
  captureRequired: boolean;
  orientation: Side;
  synced: boolean;
}

export interface ControllerHooks {
  change?(view: ControllerView): void;
  moveShown?(move: Move, mover: Side, ply: number): void;
  select?(): void;
  hop?(): void;
  illegal?(reason: IllegalReason): void;
  rejected?(move: string): void;
  gameOver?(result: GameResult, finalPosition: Position): void;
  gameResumed?(): void;
}

export interface ControllerOptions {
  orientation: Side;
  hooks?: ControllerHooks;
  gameOverDelayMs?: number;
}

interface Rendered {
  startFen: string;
  moves: string[];
  game: Game;
  ids: PieceIds;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const isPrefix = (a: readonly string[], b: readonly string[]) => a.length <= b.length && a.every((x, i) => x === b[i]);

export function resultKey(s: DriverSnapshot): string | null {
  return s.result ? `${s.startFen}|${s.moves.length}|${s.result.reason}|${s.result.winner}` : null;
}

export class GameController {
  readonly driver: GameDriver;
  #hooks: ControllerHooks;
  #orientation: Side;
  #gameOverDelayMs: number;
  #board: BoardView | null = null;
  #latest: DriverSnapshot;
  #latestGame: Game;
  #rendered: Rendered | null = null;
  #selection: SelectionState | null = null;
  #selectionKey = '';
  #previewedHops = 0;
  #pendingPreview: { move: string; hops: number } | null = null;
  #cursor: Sq | null = null;
  #pumping = false;
  #input: Promise<void> = Promise.resolve();
  #shownResult: string | null = null;
  #gameOverTimer: ReturnType<typeof setTimeout> | null = null;
  #unsubscribe: () => void;
  #untap: (() => void) | null = null;
  #disposed = false;

  constructor(driver: GameDriver, opts: ControllerOptions) {
    this.driver = driver;
    this.#hooks = opts.hooks ?? {};
    this.#orientation = opts.orientation;
    this.#gameOverDelayMs = opts.gameOverDelayMs ?? 500;
    this.#latest = driver.snapshot();
    this.#latestGame = Game.fromMoves(this.#latest.moves, { startFen: this.#latest.startFen });
    this.#unsubscribe = driver.subscribe((s) => this.#onSnapshot(s));
  }

  get orientation(): Side {
    return this.#orientation;
  }

  get board(): BoardView | null {
    return this.#board;
  }

  get game(): Game {
    return this.#latestGame;
  }

  get snapshot(): DriverSnapshot {
    return this.#latest;
  }

  get idle(): boolean {
    return !this.#pumping && this.#synced();
  }

  attach(board: BoardView): void {
    if (this.#disposed) return;
    this.#board = board;
    void board.setOrientation(this.#orientation, false);
    this.#untap = board.onSquareTap((sq) => this.tap(sq));
    void this.#pump();
  }

  view(): ControllerView {
    return {
      snapshot: this.#latest,
      position: this.#latestGame.position,
      status: this.status(),
      canMove: this.#selection !== null,
      captureRequired: this.#selection !== null && isCaptureState(this.#selection),
      orientation: this.#orientation,
      synced: this.#synced(),
    };
  }

  status(): GameStatus {
    const r = this.#latest.result;
    return r ? { over: true, winner: r.winner, reason: r.reason } : this.#latestGame.status();
  }

  fen(): string {
    return toFen(this.#latestGame.position);
  }

  setOrientation(side: Side, animate: boolean): void {
    if (side === this.#orientation) return;
    this.#orientation = side;
    if (this.#board) void this.#board.setOrientation(side, animate);
    this.#emit();
  }

  flip(animate: boolean): void {
    this.setOrientation((1 - this.#orientation) as Side, animate);
  }

  tap(sq: Sq | null): void {
    this.#input = this.#input.then(() => this.#handleTap(sq)).catch((err) => console.error(err));
  }

  moveCursor(dir: Direction): void {
    if (this.#cursor === null) {
      const v = this.#selection ? selectionView(this.#selection) : null;
      const preferred = v ? (v.current !== null ? [v.current] : v.movable) : [];
      this.#cursor = startCursor(preferred, this.#orientation);
    } else {
      this.#cursor = stepCursor(this.#cursor, dir, this.#orientation);
    }
    this.#applyHighlights();
  }

  activateCursor(): Promise<void> {
    if (this.#cursor !== null) this.tap(this.#cursor);
    return this.#input;
  }

  describeCursor(): string | null {
    const sq = this.#cursor;
    if (sq === null) return null;
    const piece = pieceAt(this.#latestGame.position, sq);
    const parts = [`Square ${sq + 1}`, piece ? `${SIDE_NAMES[piece.side].toLowerCase()} ${piece.king ? 'king' : 'man'}` : 'empty'];
    const v = this.#selection ? selectionView(this.#selection) : null;
    if (v) {
      if (sq === v.current) parts.push('selected');
      else if (v.current !== null && (v.targets.includes(sq) || v.captureTargets.includes(sq))) parts.push(`landing for ${v.current + 1}`);
      else if (v.movable.includes(sq)) parts.push('movable');
    }
    return parts.join(', ');
  }

  describeSelection(): string | null {
    const v = this.#selection ? selectionView(this.#selection) : null;
    if (!v || v.selected === null || v.current === null) return null;
    const next = [...v.targets, ...v.captureTargets].map((sq) => String(sq + 1));
    const list = next.length > 1 ? `${next.slice(0, -1).join(', ')} or ${next[next.length - 1]}` : next.join('');
    const verb = v.captureRequired ? 'jump' : 'move';
    return v.current === v.selected ? `Selected ${v.selected + 1}; can ${verb} to ${list}` : `Jumped to ${v.current + 1}; continue to ${list}`;
  }

  get cursor(): Sq | null {
    return this.#cursor;
  }

  cancel(): void {
    this.#input = this.#input.then(() => {
      if (!this.#selection) return;
      const { state, effect } = cancelSelection(this.#selection);
      this.#selection = state;
      if (effect.kind === 'deselect' && effect.revertHops > 0) this.#board?.cancelPreview();
      this.#previewedHops = 0;
      this.#applyHighlights();
      this.#emit();
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#untap?.();
    if (this.#gameOverTimer) clearTimeout(this.#gameOverTimer);
    if (this.#board) {
      this.#board.cancelPreview();
      this.#board.setHighlights({});
    }
  }

  #synced(): boolean {
    const r = this.#rendered;
    return !!r && r.startFen === this.#latest.startFen && sameList(r.moves, this.#latest.moves);
  }

  #onSnapshot(s: DriverSnapshot): void {
    if (this.#disposed) return;
    const prev = this.#latest;
    this.#latest = s;
    const g = this.#latestGame;
    if (s.startFen !== prev.startFen || !isPrefix(g.notation(), s.moves)) {
      this.#latestGame = Game.fromMoves(s.moves, { startFen: s.startFen });
    } else {
      for (const m of s.moves.slice(g.moves.length)) g.play(m);
    }
    if (this.#pumping) return this.#emit();
    if (!this.#synced()) {
      void this.#pump();
      return;
    }
    this.#refreshSelection();
    this.#applyHighlights();
    this.#emit();
    this.#checkGameOver();
  }

  async #pump(): Promise<void> {
    if (this.#pumping || !this.#board || this.#disposed) return;
    this.#pumping = true;
    this.#selection = null;
    this.#applyHighlights();
    this.#emit();
    try {
      while (!this.#disposed && !this.#synced()) await this.#step(this.#board);
    } finally {
      this.#pumping = false;
    }
    if (this.#disposed) return;
    this.#refreshSelection();
    this.#applyHighlights();
    this.#emit();
    this.#checkGameOver();
  }

  async #step(board: BoardView): Promise<void> {
    const target = this.#latest;
    const r = this.#rendered;
    if (r && r.startFen === target.startFen && target.moves.length === r.moves.length + 1 && isPrefix(r.moves, target.moves)) {
      const text = target.moves[r.moves.length];
      const mover = r.game.position.turn;
      let move: Move;
      try {
        move = r.game.play(text);
      } catch {
        return this.#snapTo(board, target);
      }
      const pending = this.#pendingPreview;
      const fromHop = pending?.move === text ? pending.hops : 0;
      if (pending && pending.hops > 0 && pending.move !== text) board.cancelPreview();
      this.#pendingPreview = null;
      r.ids = applyMoveIds(r.ids, move);
      r.moves.push(text);
      board.setHighlights({ lastMove: null, cursor: this.#cursor });
      try {
        await board.playMove(move, { fromHop });
      } catch (err) {
        console.error(err);
      }
      if (!this.#disposed) this.#hooks.moveShown?.(move, mover, r.moves.length);
      return;
    }
    return this.#snapTo(board, target);
  }

  async #snapTo(board: BoardView, target: DriverSnapshot): Promise<void> {
    if ((this.#pendingPreview?.hops ?? 0) > 0 || this.#previewedHops > 0) board.cancelPreview();
    this.#pendingPreview = null;
    this.#previewedHops = 0;
    const game = Game.fromMoves(target.moves, { startFen: target.startFen });
    const ids = idsAfterMoves(fromFen(target.startFen), game.moves);
    const first = this.#rendered === null;
    this.#rendered = { startFen: target.startFen, moves: [...target.moves], game, ids };
    if (first) board.setPosition(game.position, ids);
    else {
      try {
        await board.sync(game.position, ids);
      } catch (err) {
        console.error(err);
      }
    }
  }

  #refreshSelection(): void {
    const s = this.#latest;
    const pos = this.#latestGame.position;
    const key = `${s.startFen}|${s.moves.length}`;
    const canMove = this.#synced() && !this.#pumping && !s.result && !s.thinking && s.mySides.includes(pos.turn);
    if (!canMove) {
      if (this.#selection && this.#selection.prefix.length > 1) this.#board?.cancelPreview();
      this.#selection = null;
      this.#previewedHops = 0;
      return;
    }
    if (this.#selection && this.#selectionKey === key) return;
    this.#selection = createSelection(pos, this.#latestGame.legalMoves());
    this.#selectionKey = key;
    this.#previewedHops = 0;
  }

  async #handleTap(sq: Sq | null): Promise<void> {
    if (this.#disposed || !this.#selection || this.#pumping) return;
    const { state, effect } = tapSquare(this.#selection, sq);
    this.#selection = state;
    if (sq !== null) this.#cursor = this.#cursor === null ? null : sq;
    switch (effect.kind) {
      case 'select':
        this.#hooks.select?.();
        break;
      case 'deselect':
        if (effect.revertHops > 0) this.#board?.cancelPreview();
        this.#previewedHops = 0;
        break;
      case 'advance':
        this.#applyHighlights();
        for (const hop of effect.hops) {
          await this.#board?.previewHop(hop.from, hop.to, hop.captured);
          if (this.#disposed || this.#selection !== state) break;
          this.#previewedHops++;
          this.#hooks.hop?.();
        }
        break;
      case 'commit':
        this.#commit(effect.move, effect.previewedHops);
        break;
      case 'illegal':
        this.#hooks.illegal?.(effect.reason);
        break;
      case 'none':
        break;
    }
    if (this.#disposed) return;
    this.#applyHighlights();
    this.#emit();
  }

  #commit(move: Move, previewedHops: number): void {
    const text = moveToString(move);
    this.#pendingPreview = { move: text, hops: previewedHops };
    this.#previewedHops = 0;
    this.#selection = null;
    if (this.driver.submitMove(text)) return;
    this.#pendingPreview = null;
    if (previewedHops > 0) this.#board?.cancelPreview();
    this.#hooks.rejected?.(text);
    this.#refreshSelection();
  }

  #applyHighlights(): void {
    const board = this.#board;
    if (!board || this.#disposed) return;
    const r = this.#rendered;
    const last = r && r.game.moves.length > 0 ? r.game.moves[r.game.moves.length - 1] : null;
    const h: Highlights = { lastMove: last ? [last.from, last.to] : null, cursor: this.#cursor };
    if (this.#selection) {
      const v = selectionView(this.#selection);
      Object.assign(h, {
        movable: v.movable,
        selected: v.selected,
        targets: v.targets,
        captureTargets: v.captureTargets,
        pending: v.pending,
      });
    }
    board.setHighlights(h);
  }

  #checkGameOver(): void {
    const key = resultKey(this.#latest);
    if (key === this.#shownResult) return;
    if (this.#gameOverTimer) clearTimeout(this.#gameOverTimer);
    this.#gameOverTimer = null;
    const wasOver = this.#shownResult !== null;
    this.#shownResult = key;
    if (key === null) {
      if (wasOver) this.#hooks.gameResumed?.();
      return;
    }
    const result = this.#latest.result!;
    const position = this.#latestGame.position;
    this.#gameOverTimer = setTimeout(() => {
      this.#gameOverTimer = null;
      if (!this.#disposed && resultKey(this.#latest) === key) this.#hooks.gameOver?.(result, position);
    }, this.#gameOverDelayMs);
  }

  #emit(): void {
    if (!this.#disposed) this.#hooks.change?.(this.view());
  }
}
