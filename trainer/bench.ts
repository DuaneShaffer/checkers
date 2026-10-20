import { readFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { parseArgs } from 'node:util';
import { Game, Rng, initialPosition, mixSeed, perft } from '../src/engine/index.ts';
import type { Position } from '../src/engine/index.ts';
import { NetEvaluator, Network } from '../src/ai/network.ts';
import { Searcher } from '../src/ai/search.ts';
import { DEFAULT_LAYERS } from '../src/shared/formats.ts';
import { Adam, DEFAULT_TRAIN, NetTrainer } from './nn-train.ts';
import { createPool } from './pool.ts';
import { DEFAULT_SELFPLAY } from './selfplay.ts';
import type { PackedSamples } from './selfplay.ts';
import type { SelfPlayResult, WorkerRequest } from './selfplay-worker.ts';

function randomPositions(count: number, rng: Rng): Position[] {
  const out: Position[] = [];
  while (out.length < count) {
    const game = new Game();
    const plies = 10 + rng.int(60);
    for (let i = 0; i < plies && !game.status().over; i++) {
      game.play(rng.pick(game.legalMoves()));
      if (!game.status().over) out.push(game.position);
    }
  }
  return out.slice(0, count);
}

function rate(count: number, ms: number): string {
  const perSec = (count * 1000) / ms;
  return perSec >= 1e6 ? `${(perSec / 1e6).toFixed(2)}M/s` : perSec >= 1e3 ? `${(perSec / 1e3).toFixed(1)}k/s` : `${perSec.toFixed(2)}/s`;
}

function benchPerft(): void {
  const depth = 8;
  const t0 = performance.now();
  const nodes = perft(initialPosition(), depth);
  const ms = performance.now() - t0;
  console.log(`perft(${depth})            ${nodes} leaves in ${ms.toFixed(0)} ms  (${rate(nodes, ms)})`);
}

function benchEval(net: Network, positions: Position[]): void {
  const reps = 20;
  let sink = 0;
  const t0 = performance.now();
  for (let r = 0; r < reps; r++) for (const p of positions) sink += net.value(p);
  const ms = performance.now() - t0;
  console.log(`net eval                ${rate(reps * positions.length, ms)}  (${((ms * 1000) / (reps * positions.length)).toFixed(2)} µs each)${sink === Infinity ? '!' : ''}`);
}

function benchSearch(net: Network, positions: Position[], depth: number): void {
  const searcher = new Searcher(new NetEvaluator(net), { ttBits: 18 });
  let nodes = 0;
  const t0 = performance.now();
  for (const p of positions) {
    searcher.clear();
    nodes += searcher.search(p, { maxDepth: depth }).nodes;
  }
  const ms = performance.now() - t0;
  console.log(`search depth ${depth}         ${rate(nodes, ms)} nodes, ${(nodes / positions.length).toFixed(0)} nodes/move, ${(ms / positions.length).toFixed(1)} ms/move`);
}

function benchTrain(net: Network, positions: Position[]): number {
  const samples: PackedSamples = { boards: new Uint32Array(positions.length * 4), targets: new Float32Array(positions.length) };
  positions.forEach((p, i) => {
    samples.boards.set([p.black, p.white, p.kings, p.turn], 4 * i);
    samples.targets[i] = Math.sin(i);
  });
  const trainer = new NetTrainer(net.sizes);
  const params = net.params.slice();
  const t0 = performance.now();
  trainer.train(params, new Adam(params.length), samples, { ...DEFAULT_TRAIN, lr: 1e-3, epochs: 1, seed: 1 });
  const ms = performance.now() - t0;
  const perSec = (positions.length * 1000) / ms;
  console.log(`train fwd+bwd+adam      ${rate(positions.length, ms)} samples`);
  return perSec;
}

async function benchSelfplay(net: Network, workers: number, games: number, depth: number): Promise<{ gps: number; plies: number; samples: number }> {
  const pool = await createPool(workers);
  try {
    await pool.broadcast({ type: 'nets', nets: [{ gen: 0, sizes: [...net.sizes], params: net.params }] });
    const tasks: WorkerRequest[] = Array.from({ length: games }, (_, i) => ({
      type: 'selfplay',
      gen: 0,
      games: 1,
      seed: mixSeed(99, i),
      options: { ...DEFAULT_SELFPLAY, depth },
    }));
    const t0 = performance.now();
    const results = await pool.run<SelfPlayResult>(tasks);
    const ms = performance.now() - t0;
    const plies = results.reduce((n, r) => n + r.games[0].moves.length, 0);
    const samples = results.reduce((n, r) => n + r.samples.targets.length, 0);
    const nodes = results.reduce((n, r) => n + r.nodes, 0);
    const gps = (games * 1000) / ms;
    console.log(
      `self-play depth ${depth}     ${gps.toFixed(2)} games/s with ${pool.mode === 'threads' ? `${pool.size} workers` : 'inline'}  ` +
        `(${games} games, ${(plies / games).toFixed(0)} plies/game, ${rate(nodes, ms)} nodes total, ${(ms / 1000).toFixed(1)} s)`,
    );
    return { gps, plies: plies / games, samples: samples / games };
  } finally {
    await pool.close();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { workers: { type: 'string' }, games: { type: 'string' }, depth: { type: 'string' }, net: { type: 'string' }, quick: { type: 'boolean' } },
    strict: true,
  });
  const workers = values.workers !== undefined ? Number(values.workers) : Math.max(1, availableParallelism() - 1);
  const depth = values.depth !== undefined ? Number(values.depth) : 4;
  const games = values.games !== undefined ? Number(values.games) : Math.max(24, workers * (values.quick ? 3 : 20));
  console.log(`${cpus()[0]?.model ?? 'cpu'} x${availableParallelism()}, node ${process.version}`);

  const rng = new Rng(7);
  const net = values.net ? Network.fromBinary(readFileSync(values.net)) : Network.random(DEFAULT_LAYERS, () => rng.next(), 0);
  console.log(values.net ? `net ${values.net} (gen ${net.gen})` : 'random-init net (short games; pass --net <gen.bin> to bench a trained net)');
  const positions = randomPositions(values.quick ? 2000 : 20000, rng);
  benchPerft();
  benchEval(net, positions);
  benchSearch(net, positions.slice(0, values.quick ? 40 : 200), depth);
  const trainRate = benchTrain(net, positions);
  const sp = await benchSelfplay(net, workers, games, depth);

  const perGen = 2000;
  const playSec = perGen / sp.gps;
  const trainSec = (2 * 2 * perGen * sp.samples) / trainRate;
  console.log(
    `\nsummary: ${sp.gps.toFixed(1)} games/s at depth ${depth} on ${workers} workers; ` +
      `a ${perGen}-game generation ≈ ${playSec.toFixed(0)} s play + ${trainSec.toFixed(0)} s train (2 replay gens × 2 epochs) + gauntlet; ` +
      `gate (≥15 games/s): ${sp.gps >= 15 ? 'PASS' : 'MISS'}`,
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
