import type { DriverSnapshot, GameDriver } from './driver.ts';
import { SnapshotHub } from './snapshotHub.ts';

export class ReviewDriver implements GameDriver {
  readonly startFen: string;
  readonly allMoves: readonly string[];
  #ply: number;
  #hub = new SnapshotHub();

  constructor(startFen: string, moves: readonly string[], ply = moves.length) {
    this.startFen = startFen;
    this.allMoves = moves;
    this.#ply = clamp(ply, moves.length);
  }

  get ply(): number {
    return this.#ply;
  }

  subscribe(fn: (s: DriverSnapshot) => void): () => void {
    return this.#hub.subscribe(fn, this.snapshot());
  }

  snapshot(): DriverSnapshot {
    return { startFen: this.startFen, moves: this.allMoves.slice(0, this.#ply), mySides: [] };
  }

  seek(ply: number): void {
    const next = clamp(ply, this.allMoves.length);
    if (next === this.#ply) return;
    this.#ply = next;
    this.#hub.emit(this.snapshot());
  }

  step(delta: number): void {
    this.seek(this.#ply + delta);
  }

  submitMove(): boolean {
    return false;
  }

  resign(): void {}

  dispose(): void {
    this.#hub.clear();
  }
}

function clamp(ply: number, max: number): number {
  return Math.max(0, Math.min(max, Math.trunc(ply)));
}
