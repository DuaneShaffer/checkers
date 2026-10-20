import { Game } from '../engine/game.ts';
import { moveToString } from '../engine/notation.ts';
import { mulberry32 } from '../engine/rng.ts';
import type { Move } from '../engine/types.ts';
import { HeuristicEvaluator } from './heuristic.ts';
import type { LevelSpec } from './levels.ts';
import { NetEvaluator, Network } from './network.ts';
import type { AiRequest, AiResponse } from './protocol.ts';
import { DEFAULT_TT_BITS, Searcher, pickMove, type Evaluator, type SearchOptions } from './search.ts';

export const LOW_MEMORY_TT_BITS = 18;
const FORCED_MOVE_DEPTH = 4;
const FORCED_MOVE_MS = 50;

export interface AiWorkerDeps {
  post(msg: AiResponse): void;
  fetchBytes?(url: string): Promise<ArrayBuffer>;
  ttBits?: number;
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.arrayBuffer();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sameMove(a: Move, b: Move): boolean {
  return a.path.length === b.path.length && a.path.every((sq, i) => sq === b.path[i]);
}

function checkLevel(level: LevelSpec): void {
  const ok = !!level
    && Number.isFinite(level.maxDepth) && level.maxDepth >= 1
    && Number.isFinite(level.timeMs) && level.timeMs > 0
    && Number.isFinite(level.temperature) && level.temperature >= 0
    && Number.isFinite(level.blunderRate) && level.blunderRate >= 0;
  if (!ok) throw new Error('Invalid level spec');
}

export class AiWorkerCore {
  private readonly deps: AiWorkerDeps;
  private readonly nets = new Map<string, NetEvaluator>();
  private readonly loading = new Map<string, Promise<NetEvaluator | null>>();
  private readonly heuristic = new HeuristicEvaluator();
  private loadChain: Promise<unknown> = Promise.resolve();
  private searcher: Searcher | null = null;

  constructor(deps: AiWorkerDeps) {
    this.deps = deps;
  }

  handle(req: AiRequest): Promise<void> {
    switch (req?.type) {
      case 'loadNet':
        return this.loadNet(req.netId, req.url);
      case 'think':
        return this.think(req);
      default:
        this.deps.post({ type: 'error', message: `Unknown request ${JSON.stringify((req as { type?: unknown })?.type)}` });
        return Promise.resolve();
    }
  }

  private loadNet(netId: string, url: string): Promise<void> {
    const loaded = this.loadChain.then(() => this.fetchNet(netId, url));
    const tracked = loaded.finally(() => {
      if (this.loading.get(netId) === tracked) this.loading.delete(netId);
    });
    this.loading.set(netId, tracked);
    this.loadChain = tracked;
    return tracked.then(() => undefined);
  }

  private async fetchNet(netId: string, url: string): Promise<NetEvaluator | null> {
    try {
      const bytes = await (this.deps.fetchBytes ?? fetchBytes)(url);
      const evaluator = new NetEvaluator(Network.fromBinary(bytes));
      this.nets.set(netId, evaluator);
      this.deps.post({ type: 'netLoaded', netId, gen: evaluator.net.gen });
      return evaluator;
    } catch (err) {
      this.deps.post({ type: 'error', message: `Could not load net ${netId}: ${errorMessage(err)}` });
      return null;
    }
  }

  private async evaluatorFor(netId: string): Promise<Evaluator> {
    if (netId === 'heuristic') return this.heuristic;
    const pending = this.loading.get(netId);
    const evaluator = pending ? await pending : this.nets.get(netId);
    if (!evaluator) throw new Error(`Net ${netId} is not loaded`);
    return evaluator;
  }

  private async think(req: Extract<AiRequest, { type: 'think' }>): Promise<void> {
    try {
      this.deps.post(this.search(req, await this.evaluatorFor(req.netId)));
    } catch (err) {
      this.deps.post({ type: 'error', reqId: req.reqId, message: errorMessage(err) });
    }
  }

  private search(req: Extract<AiRequest, { type: 'think' }>, evaluator: Evaluator): AiResponse {
    const { level } = req;
    checkLevel(level);
    const game = Game.fromMoves(req.moves, { startFen: req.startFen });
    if (game.status().over) throw new Error('Game is already over');
    const forced = game.legalMoves().length === 1;
    const searcher = this.searcherFor(evaluator);
    const opts: SearchOptions = {
      maxDepth: forced ? Math.min(level.maxDepth, FORCED_MOVE_DEPTH) : level.maxDepth,
      timeMs: forced ? Math.min(level.timeMs, FORCED_MOVE_MS) : level.timeMs,
      threatExtension: level.threatExtension,
      rootScores: !forced && (level.temperature > 0 || level.blunderRate > 0),
      history: game.historyHashes(),
      quietPlies: game.quietPlies,
    };
    const result = searcher.search(game.position, opts);
    const seed = req.seed ?? Math.floor(Math.random() * 0x100000000);
    const chosen = pickMove(result, level, mulberry32(seed));
    const isBest = sameMove(chosen, result.move);
    const score = isBest ? result.score : result.rootScores?.find((r) => sameMove(r.move, chosen))?.score ?? result.score;
    return {
      type: 'move',
      reqId: req.reqId,
      move: moveToString(chosen),
      score,
      depth: result.depth,
      nodes: result.nodes,
      pv: (isBest ? result.pv : [chosen]).map(moveToString),
      ms: Math.round(result.ms),
    };
  }

  private searcherFor(evaluator: Evaluator): Searcher {
    if (!this.searcher) this.searcher = new Searcher(evaluator, { ttBits: this.deps.ttBits ?? DEFAULT_TT_BITS });
    else this.searcher.setEvaluator(evaluator);
    return this.searcher;
  }
}

export function defaultTtBits(): number {
  const memory = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory;
  return memory !== undefined && memory <= 2 ? LOW_MEMORY_TT_BITS : DEFAULT_TT_BITS;
}

interface WorkerScope {
  WorkerGlobalScope?: unknown;
  postMessage(msg: AiResponse): void;
  onmessage: ((e: MessageEvent<AiRequest>) => void) | null;
}

const scope = globalThis as unknown as WorkerScope;
if (typeof scope.WorkerGlobalScope === 'function') {
  const core = new AiWorkerCore({ post: (msg) => scope.postMessage(msg), ttBits: defaultTtBits() });
  scope.onmessage = (e) => void core.handle(e.data);
}
