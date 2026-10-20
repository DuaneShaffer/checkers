import { Game } from '../engine/game.ts';
import { INITIAL_FEN } from '../engine/position.ts';
import type { Side } from '../engine/types.ts';
import type { GameResult } from '../net/protocol.ts';
import type { DriverSnapshot, GameDriver } from './driver.ts';
import { SnapshotHub } from './snapshotHub.ts';

export interface LocalDriverOptions {
  startFen?: string;
  moves?: readonly string[];
}

export function statusResult(game: Game): GameResult | undefined {
  const st = game.status();
  return st.over ? { winner: st.winner, reason: st.reason } : undefined;
}

export function tryPlay(game: Game, move: string): boolean {
  try {
    game.play(move);
    return true;
  } catch {
    return false;
  }
}

export class LocalDriver implements GameDriver {
  #game: Game;
  #result: GameResult | undefined;
  #hub = new SnapshotHub();
  #disposed = false;

  constructor(opts: LocalDriverOptions = {}) {
    this.#game = Game.fromMoves(opts.moves ?? [], { startFen: opts.startFen ?? INITIAL_FEN });
    this.#result = statusResult(this.#game);
  }

  subscribe(fn: (s: DriverSnapshot) => void): () => void {
    return this.#hub.subscribe(fn, this.snapshot());
  }

  snapshot(): DriverSnapshot {
    return {
      startFen: this.#game.startFen,
      moves: this.#game.notation(),
      mySides: [0, 1],
      result: this.#result,
    };
  }

  submitMove(move: string): boolean {
    if (this.#disposed || this.#result) return false;
    if (!tryPlay(this.#game, move)) return false;
    this.#result = statusResult(this.#game);
    this.#emit();
    return true;
  }

  undo(): void {
    if (this.#disposed || this.#game.moves.length === 0 || this.#result?.reason === 'resign') return;
    this.#game.undo();
    this.#result = statusResult(this.#game);
    this.#emit();
  }

  resign(): void {
    if (this.#disposed || this.#result) return;
    const loser: Side = this.#game.position.turn;
    this.#result = { winner: (1 - loser) as Side, reason: 'resign' };
    this.#emit();
  }

  dispose(): void {
    this.#disposed = true;
    this.#hub.clear();
  }

  #emit(): void {
    this.#hub.emit(this.snapshot());
  }
}
