import { isMainThread, parentPort } from 'node:worker_threads';
import { Rng, mixSeed } from '../src/engine/index.ts';
import { HeuristicEvaluator } from '../src/ai/heuristic.ts';
import { NetEvaluator, Network } from '../src/ai/network.ts';
import { Searcher } from '../src/ai/search.ts';
import { openings, playMatchGame, scoreFor } from './gauntlet.ts';
import type { MatchGame, MatchPairing, MatchPlayer, PlayerSpec } from './gauntlet.ts';
import { packSamples, playSelfPlayGame } from './selfplay.ts';
import type { PackedSamples, PlayedGame, SelfPlayOptions } from './selfplay.ts';

export const WORKER_TT_BITS = 18;

export interface NetPayload {
  gen: number;
  sizes: number[];
  params: Float32Array;
}

export type WorkerRequest =
  | { type: 'nets'; nets: NetPayload[] }
  | { type: 'selfplay'; gen: number; games: number; seed: number; options: SelfPlayOptions }
  | { type: 'match'; a: PlayerSpec; b: PlayerSpec; pairings: MatchPairing[]; seed: number; maxPlies: number }
  | { type: 'ping' };

export interface SelfPlayResult {
  games: PlayedGame[];
  samples: PackedSamples;
  nodes: number;
  ms: number;
}

export interface MatchResult {
  games: MatchGame[];
  ms: number;
}

export type WorkerResult = SelfPlayResult | MatchResult | { pong: true } | null;

export interface TaskEnvelope {
  id: number;
  req: WorkerRequest;
}

export type TaskReply = { id: number; ok: true; result: WorkerResult } | { id: number; ok: false; error: string };

export class TaskHandler {
  private readonly nets = new Map<number, Network>();
  private readonly searchers = new Map<string, Searcher>();

  handle(req: WorkerRequest): WorkerResult {
    switch (req.type) {
      case 'ping':
        return { pong: true };
      case 'nets':
        this.setNets(req.nets);
        return null;
      case 'selfplay':
        return this.selfplay(req.gen, req.games, req.seed, req.options);
      case 'match':
        return this.match(req.a, req.b, req.pairings, req.seed, req.maxPlies);
    }
  }

  private setNets(payloads: readonly NetPayload[]): void {
    this.nets.clear();
    for (const p of payloads) this.nets.set(p.gen, new Network(p.sizes, new Float32Array(p.params), p.gen));
    for (const key of [...this.searchers.keys()]) if (key.startsWith('net:')) this.searchers.delete(key);
  }

  private net(gen: number): Network {
    const net = this.nets.get(gen);
    if (!net) throw new Error(`Worker has no weights for generation ${gen}`);
    return net;
  }

  private searcherFor(spec: PlayerSpec, slot: string): Searcher | null {
    if (spec.kind === 'random') return null;
    const key = spec.kind === 'net' ? `net:${spec.gen}:${slot}` : `heur:${slot}`;
    let s = this.searchers.get(key);
    if (!s) {
      const ev = spec.kind === 'net' ? new NetEvaluator(this.net(spec.gen)) : new HeuristicEvaluator();
      s = new Searcher(ev, { ttBits: WORKER_TT_BITS });
      this.searchers.set(key, s);
    }
    return s;
  }

  private selfplay(gen: number, count: number, seed: number, options: SelfPlayOptions): SelfPlayResult {
    const started = performance.now();
    const net = this.net(gen);
    const searcher = this.searcherFor({ kind: 'net', gen, depth: options.depth }, 'self')!;
    const played = [];
    for (let i = 0; i < count; i++) {
      const rng = new Rng(mixSeed(seed, i));
      const opening = rng.pick(openings());
      played.push(playSelfPlayGame(net, searcher, opening, () => rng.next(), options));
    }
    const samples = packSamples(played);
    const games = played.map(({ leaves: _leaves, targets: _targets, nodes: _nodes, ...record }) => record);
    return { games, samples, nodes: played.reduce((n, g) => n + g.nodes, 0), ms: performance.now() - started };
  }

  private match(a: PlayerSpec, b: PlayerSpec, pairings: readonly MatchPairing[], seed: number, maxPlies: number): MatchResult {
    const started = performance.now();
    const pa: MatchPlayer = { spec: a, searcher: this.searcherFor(a, 'a') };
    const pb: MatchPlayer = { spec: b, searcher: this.searcherFor(b, 'b') };
    const games = pairings.map((pairing, i) => {
      const rng = new Rng(mixSeed(seed, i));
      const [black, white] = pairing.aIsBlack ? [pa, pb] : [pb, pa];
      const g = playMatchGame(black, white, pairing.opening, () => rng.next(), maxPlies, pa);
      return { ...g, aIsBlack: pairing.aIsBlack, aScore: scoreFor(g.result, pairing.aIsBlack ? 0 : 1) };
    });
    return { games, ms: performance.now() - started };
  }
}

export function transferables(result: WorkerResult): ArrayBuffer[] {
  if (result && 'samples' in result) return [result.samples.boards.buffer as ArrayBuffer, result.samples.targets.buffer as ArrayBuffer];
  return [];
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  const handler = new TaskHandler();
  port.on('message', (env: TaskEnvelope) => {
    let reply: TaskReply;
    let transfer: ArrayBuffer[] = [];
    try {
      const result = handler.handle(env.req);
      transfer = transferables(result);
      reply = { id: env.id, ok: true, result };
    } catch (e) {
      reply = { id: env.id, ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) };
    }
    port.postMessage(reply, transfer);
  });
}
