import type { LevelSpec } from '../ai/levels.ts';
import type { AiClientApi, AiMove, NetId } from '../ai/protocol.ts';
import { Game } from '../engine/game.ts';
import { INITIAL_FEN } from '../engine/position.ts';
import type { Move, Side } from '../engine/types.ts';
import type { GameResult } from '../net/protocol.ts';
import type { DriverSnapshot, GameDriver } from './driver.ts';
import { statusResult, tryPlay } from './localDriver.ts';
import { SnapshotHub } from './snapshotHub.ts';

export interface AiEngine {
  client: AiClientApi;
  netId: NetId;
}

export type AiEngineSource = AiEngine | Promise<AiEngine> | (() => AiEngine | Promise<AiEngine>);

export interface AiDriverOptions {
  engine: AiEngineSource;
  humanSide: Side;
  level: LevelSpec;
  startFen?: string;
  moves?: readonly string[];
  minThinkMs?: number;
  seed?: () => number | undefined;
  onError?: (err: unknown) => void;
}

export const MIN_THINK_MS = 350;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class AiDriver implements GameDriver {
  readonly humanSide: Side;
  #game: Game;
  #loadEngine: () => AiEngine | Promise<AiEngine>;
  #engine: Promise<AiEngine> | null;
  #client: AiClientApi | null = null;
  #level: LevelSpec;
  #minThinkMs: number;
  #seed: () => number | undefined;
  #onError: (err: unknown) => void;
  #result: GameResult | undefined;
  #thinking = false;
  #token = 0;
  #lastScore: number | null = null;
  #hub = new SnapshotHub();
  #disposed = false;

  constructor(opts: AiDriverOptions) {
    this.humanSide = opts.humanSide;
    this.#game = Game.fromMoves(opts.moves ?? [], { startFen: opts.startFen ?? INITIAL_FEN });
    const source = opts.engine;
    this.#loadEngine = typeof source === 'function' ? source : () => source;
    this.#engine = this.#requestEngine();
    this.#level = opts.level;
    this.#minThinkMs = opts.minThinkMs ?? MIN_THINK_MS;
    this.#seed = opts.seed ?? (() => undefined);
    this.#onError = opts.onError ?? (() => undefined);
    this.#result = statusResult(this.#game);
    this.#startThinkingIfAiTurn();
  }

  get aiSide(): Side {
    return (1 - this.humanSide) as Side;
  }

  get lastScore(): number | null {
    return this.#lastScore;
  }

  get stalled(): boolean {
    return !this.#disposed && !this.#result && !this.#thinking && this.#game.position.turn === this.aiSide;
  }

  retry(): boolean {
    if (!this.stalled) return false;
    this.#startThinkingIfAiTurn();
    this.#emit();
    return true;
  }

  subscribe(fn: (s: DriverSnapshot) => void): () => void {
    return this.#hub.subscribe(fn, this.snapshot());
  }

  snapshot(): DriverSnapshot {
    return {
      startFen: this.#game.startFen,
      moves: this.#game.notation(),
      mySides: [this.humanSide],
      result: this.#result,
      thinking: this.#thinking,
    };
  }

  submitMove(move: string): boolean {
    if (this.#disposed || this.#result || this.#thinking || this.#game.position.turn !== this.humanSide) return false;
    if (!tryPlay(this.#game, move)) return false;
    this.#result = statusResult(this.#game);
    this.#startThinkingIfAiTurn();
    this.#emit();
    return true;
  }

  undo(): void {
    if (this.#disposed || this.#result?.reason === 'resign') return;
    if (this.#thinking) this.#stopThinking();
    const undone: Move[] = [];
    while (this.#game.moves.length > 0) {
      undone.push(this.#game.undo()!);
      if (this.#game.position.turn === this.humanSide) break;
    }
    if (this.#game.position.turn !== this.humanSide || undone.length === 0) {
      for (const m of undone.reverse()) this.#game.play(m);
      this.#startThinkingIfAiTurn();
      this.#emit();
      return;
    }
    this.#result = statusResult(this.#game);
    this.#emit();
  }

  resign(): void {
    if (this.#disposed || this.#result) return;
    if (this.#thinking) this.#stopThinking();
    this.#result = { winner: this.aiSide, reason: 'resign' };
    this.#emit();
  }

  dispose(): void {
    this.#disposed = true;
    this.#token++;
    this.#thinking = false;
    this.#hub.clear();
  }

  #stopThinking(): void {
    this.#token++;
    this.#thinking = false;
    this.#client?.cancel();
  }

  #startThinkingIfAiTurn(): void {
    if (this.#disposed || this.#result || this.#thinking || this.#game.position.turn === this.humanSide) return;
    this.#thinking = true;
    void this.#think(++this.#token);
  }

  async #think(token: number): Promise<void> {
    const started = performance.now();
    const stale = () => this.#disposed || token !== this.#token;
    try {
      const engine = await (this.#engine ??= this.#requestEngine());
      if (stale()) return;
      const reply = await this.#ask(engine, stale);
      const wait = this.#minThinkMs - (performance.now() - started);
      if (wait > 0) await delay(wait);
      if (stale()) return;
      if (!tryPlay(this.#game, reply.move)) throw new Error(`AI proposed an illegal move: ${reply.move}`);
      this.#lastScore = reply.score;
      this.#thinking = false;
      this.#result = statusResult(this.#game);
      this.#emit();
    } catch (err) {
      if (stale()) return;
      this.#thinking = false;
      this.#emit();
      this.#onError(err);
    }
  }

  #requestEngine(): Promise<AiEngine> {
    const pending = Promise.resolve().then(this.#loadEngine);
    pending.then(
      (e) => (this.#client = e.client),
      () => {
        if (this.#engine === pending) this.#engine = null;
      },
    );
    return pending;
  }

  async #ask(engine: AiEngine, stale: () => boolean): Promise<AiMove> {
    const ref = { startFen: this.#game.startFen, moves: this.#game.notation() };
    try {
      return await engine.client.think(ref, engine.netId, this.#level, this.#seed());
    } catch (err) {
      if (stale() || engine.netId === 'heuristic') throw err;
      return engine.client.think(ref, 'heuristic', this.#level, this.#seed());
    }
  }

  #emit(): void {
    if (!this.#disposed) this.#hub.emit(this.snapshot());
  }
}
