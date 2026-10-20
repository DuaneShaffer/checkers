import { applyMove, isIrreversible, legalMoves } from './movegen.ts';
import { matchMove, moveToString } from './notation.ts';
import { INITIAL_FEN, fromFen, samePosition, toFen } from './position.ts';
import { NO_PROGRESS_PLIES } from './types.ts';
import type { GameStatus, Move, Position, ResultStr, Side } from './types.ts';
import { hashHi, hashLo } from './zobrist.ts';

export interface GameOptions {
  startFen?: string;
  maxPlies?: number;
}

export class IllegalMoveError extends Error {
  readonly index: number;
  readonly move: string;

  constructor(index: number, move: string, reason: string) {
    super(`Illegal move at index ${index} (${move}): ${reason}`);
    this.name = 'IllegalMoveError';
    this.index = index;
    this.move = move;
  }
}

export function resultString(winner: Side | null): ResultStr {
  if (winner === null) return '1/2-1/2';
  return winner === 0 ? '1-0' : '0-1';
}

export class Game {
  readonly startFen: string;
  readonly maxPlies: number | undefined;
  private readonly played: Move[] = [];
  private readonly positions: Position[];
  private readonly quiet: number[] = [0];
  private readonly hashes: number[];
  private cachedMoves: Move[] | null = null;

  constructor(opts: GameOptions = {}) {
    const start = fromFen(opts.startFen ?? INITIAL_FEN);
    this.startFen = toFen(start);
    this.maxPlies = opts.maxPlies;
    this.positions = [start];
    this.hashes = [hashHi(start), hashLo(start)];
  }

  static fromMoves(moves: readonly string[], opts: GameOptions = {}): Game {
    const game = new Game(opts);
    moves.forEach((text, index) => {
      if (game.status().over) throw new IllegalMoveError(index, text, 'game is already over');
      const move = matchMove(game.currentMoves(), text);
      if (!move) throw new IllegalMoveError(index, text, `not a legal, unambiguous move in ${toFen(game.position)}`);
      game.push(move);
    });
    return game;
  }

  get moves(): readonly Move[] {
    return this.played;
  }

  get position(): Position {
    return this.positions[this.positions.length - 1];
  }

  get quietPlies(): number {
    return this.quiet[this.quiet.length - 1];
  }

  get ply(): number {
    return this.played.length;
  }

  fen(): string {
    return toFen(this.position);
  }

  notation(): string[] {
    return this.played.map(moveToString);
  }

  legalMoves(): Move[] {
    return this.currentMoves().slice();
  }

  play(m: Move | string): Move {
    if (this.status().over) throw new Error('Game is over');
    const move = typeof m === 'string' ? matchMove(this.currentMoves(), m) : this.findLegal(m);
    if (!move) throw new Error(`Illegal or ambiguous move ${typeof m === 'string' ? m : moveToString(m)} in ${this.fen()}`);
    this.push(move);
    return move;
  }

  undo(): Move | undefined {
    const move = this.played.pop();
    if (!move) return undefined;
    this.positions.pop();
    this.quiet.pop();
    this.hashes.length -= 2;
    this.cachedMoves = null;
    return move;
  }

  status(): GameStatus {
    const turn = this.position.turn;
    if (this.currentMoves().length === 0) return { over: true, winner: (1 - turn) as Side, reason: 'no-moves' };
    if (this.repetitions() >= 3) return { over: true, winner: null, reason: 'repetition' };
    if (this.quietPlies >= NO_PROGRESS_PLIES) return { over: true, winner: null, reason: 'no-progress' };
    if (this.maxPlies !== undefined && this.played.length >= this.maxPlies) {
      return { over: true, winner: null, reason: 'max-plies' };
    }
    return { over: false };
  }

  historyHashes(): Uint32Array {
    const first = this.positions.length - 1 - this.quietPlies;
    return Uint32Array.from(this.hashes.slice(first * 2));
  }

  private repetitions(): number {
    const current = this.position;
    const last = this.positions.length - 1;
    let count = 0;
    for (let i = last - this.quietPlies; i <= last; i++) {
      if (samePosition(this.positions[i], current)) count++;
    }
    return count;
  }

  private currentMoves(): Move[] {
    return (this.cachedMoves ??= legalMoves(this.position));
  }

  private findLegal(m: Move): Move | undefined {
    return this.currentMoves().find(
      (legal) => legal.path.length === m.path.length && legal.path.every((sq, i) => sq === m.path[i]),
    );
  }

  private push(move: Move): void {
    const before = this.position;
    const after = applyMove(before, move);
    this.played.push(move);
    this.positions.push(after);
    this.quiet.push(isIrreversible(before, move) ? 0 : this.quietPlies + 1);
    this.hashes.push(hashHi(after), hashLo(after));
    this.cachedMoves = null;
  }
}
