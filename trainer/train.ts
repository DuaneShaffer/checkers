import { availableParallelism } from 'node:os';
import { parseArgs } from 'node:util';
import { Rng, mixSeed } from '../src/engine/index.ts';
import { Network } from '../src/ai/network.ts';
import { DEFAULT_LAYERS } from '../src/shared/formats.ts';
import type { GameRecord, OpponentKey, PlayerId, WDL } from '../src/shared/formats.ts';
import { RunFiles, isEntryPoint, runDir } from './checkpoint.ts';
import type { GenStats, ResultLine, RunConfig, RunState, SampledGames } from './checkpoint.ts';
import { fitElo } from './elo.ts';
import { eloInputs, exportRun, pickChampion } from './export.ts';
import {
  BASELINES,
  CALIBRATION,
  RANDOM_SATURATION_GENS,
  gauntletOpponents,
  gauntletSeed,
  pairedOpenings,
  playerKey,
  scaledGames,
  tallyWdl,
} from './gauntlet.ts';
import type { MatchGame, MatchPairing, PlayerSpec } from './gauntlet.ts';
import { Adam, DEFAULT_TRAIN, NetTrainer, lambdaFor, learningRate } from './nn-train.ts';
import { createPool } from './pool.ts';
import type { Pool } from './pool.ts';
import { concatSamples } from './selfplay.ts';
import type { PackedSamples, PlayedGame } from './selfplay.ts';
import type { MatchResult, SelfPlayResult, WorkerRequest } from './selfplay-worker.ts';

const MATCH_CHUNK = 10;
const MAX_SELFPLAY_CHUNK = 25;
const MIN_SELFPLAY_CHUNK = 2;
const GAUNTLET_DEPTH = 4;
const SAMPLED_SELFPLAY = 8;
const SAMPLED_PER_OPPONENT = 2;

export function defaultConfig(run: string, smoke: boolean): RunConfig {
  const base: RunConfig = {
    run,
    smoke,
    seed: 1,
    layers: [...DEFAULT_LAYERS],
    gamesPerGen: 2000,
    workers: Math.max(1, availableParallelism() - 1),
    depthSchedule: [[0, 4], [151, 6]],
    gauntletDepth: GAUNTLET_DEPTH,
    lambda: null,
    lr: 1e-3,
    epsilon: 0.03,
    softmaxPlies: 4,
    temperature: 0.03,
    batch: DEFAULT_TRAIN.batch,
    epochs: DEFAULT_TRAIN.epochs,
    replayGens: 2,
    l2: DEFAULT_TRAIN.l2,
    clip: DEFAULT_TRAIN.clip,
    maxPlies: 300,
    gauntletScale: 1,
    maxGens: 300,
    publishEvery: 0,
    minRatedGames: 100,
    createdAt: new Date().toISOString(),
  };
  if (!smoke) return base;
  return {
    ...base,
    workers: 2,
    gamesPerGen: 100,
    depthSchedule: [[0, 2]],
    softmaxPlies: 2,
    batch: 128,
    gauntletScale: 0.15,
    maxGens: 3,
    minRatedGames: 10,
  };
}

export function depthFor(gen: number, schedule: readonly [number, number][]): number {
  let depth = schedule[0][1];
  for (const [from, d] of schedule) if (gen >= from) depth = d;
  return depth;
}

function parseSchedule(text: string): [number, number][] {
  const schedule = text.split(',').map((part) => {
    const [from, depth] = part.split(':').map(Number);
    if (!Number.isInteger(from) || !Number.isInteger(depth) || depth < 1) throw new Error(`Bad --depth-schedule entry "${part}"`);
    return [from, depth] as [number, number];
  });
  return schedule.sort((a, b) => a[0] - b[0]);
}

const CLI_OPTIONS = {
  run: { type: 'string' },
  resume: { type: 'boolean' },
  smoke: { type: 'boolean' },
  workers: { type: 'string' },
  'games-per-gen': { type: 'string' },
  depth: { type: 'string' },
  'depth-schedule': { type: 'string' },
  'gauntlet-depth': { type: 'string' },
  'max-gens': { type: 'string' },
  'publish-every': { type: 'string' },
  lambda: { type: 'string' },
  lr: { type: 'string' },
  seed: { type: 'string' },
  epsilon: { type: 'string' },
  batch: { type: 'string' },
  epochs: { type: 'string' },
  'replay-gens': { type: 'string' },
  hidden: { type: 'string' },
  'gauntlet-scale': { type: 'string' },
  'publish-out': { type: 'string' },
  help: { type: 'boolean' },
} as const;

const USAGE = `node trainer/train.ts [--run main|smoke] [--resume] [--smoke] [--workers N (0 = inline)] [--games-per-gen N]
  [--depth D | --depth-schedule 0:4,151:6] [--gauntlet-depth 4] [--max-gens N] [--publish-every N] [--lambda L] [--lr R]
  [--seed S] [--epsilon E] [--batch B] [--epochs E] [--replay-gens K] [--hidden 64,32] [--gauntlet-scale X] [--publish-out public/training]`;

function num(text: string, flag: string, integer = false): number {
  const n = Number(text);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) throw new Error(`--${flag} expects a number, got "${text}"`);
  return n;
}

type CliValues = { [K in keyof typeof CLI_OPTIONS]?: (typeof CLI_OPTIONS)[K]['type'] extends 'boolean' ? boolean : string };

export function applyOverrides(config: RunConfig, v: CliValues, creating: boolean): RunConfig {
  const c = { ...config };
  if (v.workers !== undefined) c.workers = num(v.workers, 'workers', true);
  if (v['games-per-gen'] !== undefined) c.gamesPerGen = num(v['games-per-gen'], 'games-per-gen', true);
  if (v.depth !== undefined) c.depthSchedule = [[0, num(v.depth, 'depth', true)]];
  if (v['depth-schedule'] !== undefined) c.depthSchedule = parseSchedule(v['depth-schedule']);
  if (v['gauntlet-depth'] !== undefined) c.gauntletDepth = num(v['gauntlet-depth'], 'gauntlet-depth', true);
  if (v['max-gens'] !== undefined) c.maxGens = num(v['max-gens'], 'max-gens', true);
  if (v['publish-every'] !== undefined) c.publishEvery = num(v['publish-every'], 'publish-every', true);
  if (v.lambda !== undefined) c.lambda = num(v.lambda, 'lambda');
  if (v.lr !== undefined) c.lr = num(v.lr, 'lr');
  if (v.epsilon !== undefined) c.epsilon = num(v.epsilon, 'epsilon');
  if (v.batch !== undefined) c.batch = num(v.batch, 'batch', true);
  if (v.epochs !== undefined) c.epochs = num(v.epochs, 'epochs', true);
  if (v['replay-gens'] !== undefined) c.replayGens = Math.max(1, num(v['replay-gens'], 'replay-gens', true));
  if (v['gauntlet-scale'] !== undefined) c.gauntletScale = num(v['gauntlet-scale'], 'gauntlet-scale');
  if (creating) {
    if (v.seed !== undefined) c.seed = num(v.seed, 'seed', true);
    if (v.hidden !== undefined) c.layers = [132, ...v.hidden.split(',').map((h) => num(h, 'hidden', true)), 1];
  } else if (v.seed !== undefined || v.hidden !== undefined) {
    throw new Error('--seed and --hidden can only be set when a run is created');
  }
  if (c.lambda !== null && (c.lambda < 0 || c.lambda > 1)) throw new Error('--lambda must be in [0, 1]');
  if (c.gauntletDepth < 1) throw new Error('--gauntlet-depth must be at least 1');
  return c;
}

export interface Task {
  req: WorkerRequest;
  kind: 'selfplay' | 'gauntlet' | 'calibration';
  opponent?: { key: OpponentKey; id: PlayerId };
  calibration?: { a: PlayerId; b: PlayerId };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Shrinking chunks so the generation does not end with idle workers waiting on one large chunk. */
export function selfplayChunks(games: number, workers: number): number[] {
  const chunks: number[] = [];
  const spread = 2 * Math.max(1, workers);
  for (let left = games; left > 0; ) {
    const size = Math.min(left, Math.max(MIN_SELFPLAY_CHUNK, Math.min(MAX_SELFPLAY_CHUNK, Math.ceil(left / spread))));
    chunks.push(size);
    left -= size;
  }
  return chunks;
}

function matchTasks(a: PlayerSpec, b: PlayerSpec, pairings: MatchPairing[], seed: number, maxPlies: number): WorkerRequest[] {
  return chunk(pairings, MATCH_CHUNK).map((part, k) => ({ type: 'match', a, b, pairings: part, seed: mixSeed(seed, k), maxPlies }));
}

export function planGeneration(config: RunConfig, state: RunState): Task[] {
  const g = state.gen;
  const depth = depthFor(g, config.depthSchedule);
  const seed = gauntletSeed(config.seed, g);
  const tasks: Task[] = [];
  const me: PlayerSpec = { kind: 'net', gen: g, depth: config.gauntletDepth };
  const opponents = gauntletOpponents(g, { depth: config.gauntletDepth, scale: config.gauntletScale, dropRandom: state.randomPerfectStreak >= RANDOM_SATURATION_GENS });
  opponents.forEach((opp, i) => {
    const pairings = pairedOpenings(opp.games, mixSeed(seed, i));
    for (const req of matchTasks(me, opp.spec, pairings, mixSeed(seed, i, 1), config.maxPlies)) {
      tasks.push({ req, kind: 'gauntlet', opponent: { key: opp.key, id: opp.id } });
    }
  });
  if (g === 0) {
    CALIBRATION.forEach((c, i) => {
      const pairings = pairedOpenings(scaledGames(c.games, config.gauntletScale), mixSeed(seed, 100 + i));
      for (const req of matchTasks(BASELINES[c.a].spec, BASELINES[c.b].spec, pairings, mixSeed(seed, 100 + i, 1), config.maxPlies)) {
        tasks.push({ req, kind: 'calibration', calibration: { a: c.a, b: c.b } });
      }
    });
  }
  const options = {
    depth,
    epsilon: config.epsilon,
    softmaxPlies: config.softmaxPlies,
    temperature: config.temperature,
    extraRandomPlies: 3,
    extraRandomProb: 0.3,
    maxPlies: config.maxPlies,
    lambda: lambdaFor(g, config.lambda),
  };
  selfplayChunks(config.gamesPerGen, config.workers).forEach((games, k) => {
    tasks.push({ req: { type: 'selfplay', gen: g, games, seed: mixSeed(config.seed, g, k, 0x5e1f), options }, kind: 'selfplay' });
  });
  return tasks;
}

function netGensUsed(tasks: readonly Task[]): Set<number> {
  const gens = new Set<number>();
  for (const { req } of tasks) {
    if (req.type === 'selfplay') gens.add(req.gen);
    if (req.type === 'match') for (const spec of [req.a, req.b]) if (spec.kind === 'net') gens.add(spec.gen);
  }
  return gens;
}

function toRecord(game: PlayedGame, id: string, kind: GameRecord['kind'], black: PlayerId, white: PlayerId): GameRecord {
  const rec: GameRecord = { id, kind, black, white, moves: game.moves, result: game.result, reason: game.reason, evals: game.evals };
  if (game.random.length > 0) rec.random = game.random;
  if (game.explore.length > 0) rec.explore = game.explore;
  return rec;
}

function isDecisive(g: PlayedGame): boolean {
  return g.result !== '1/2-1/2';
}

function sampleSelfplay(games: readonly PlayedGame[], gen: number): GameRecord[] {
  const picked = new Set<number>();
  for (let i = 0; i < games.length && picked.size < SAMPLED_SELFPLAY / 2; i++) picked.add(i);
  for (let i = 0; i < games.length && picked.size < SAMPLED_SELFPLAY; i++) if (isDecisive(games[i])) picked.add(i);
  for (let i = 0; i < games.length && picked.size < SAMPLED_SELFPLAY; i++) picked.add(i);
  return [...picked].sort((a, b) => a - b).map((i) => toRecord(games[i], `sp-${gen}-${i}`, 'selfplay', gen, gen));
}

function sampleMatch(games: readonly MatchGame[], gen: number, key: string, me: PlayerId, opp: PlayerId): GameRecord[] {
  const picked: number[] = [];
  const decisive = games.findIndex(isDecisive);
  if (decisive >= 0) picked.push(decisive);
  for (let i = 0; i < games.length && picked.length < SAMPLED_PER_OPPONENT; i++) if (!picked.includes(i)) picked.push(i);
  return picked.map((i) => {
    const g = games[i];
    return toRecord(g, `ga-${gen}-${key}-${i}`, 'gauntlet', g.aIsBlack ? me : opp, g.aIsBlack ? opp : me);
  });
}

function formatWdl(vs: Partial<Record<OpponentKey, WDL>>): string {
  return Object.entries(vs)
    .map(([k, r]) => `${k} ${r.w}-${r.d}-${r.l}`)
    .join('  ');
}

class Trainer {
  private readonly files: RunFiles;
  private readonly config: RunConfig;
  private state: RunState;
  private net: Network;
  private readonly adam: Adam;
  private readonly nn: NetTrainer;
  private results: ResultLine[];
  private readonly sampleCache = new Map<number, PackedSamples>();
  private readonly publishOut: string | undefined;
  stopRequested = false;

  constructor(files: RunFiles, config: RunConfig, state: RunState, publishOut?: string) {
    this.files = files;
    this.publishOut = publishOut;
    this.config = config;
    this.state = state;
    files.truncateLogs(state.gen);
    this.net = files.loadNet(state.gen);
    this.adam = files.loadAdam(state.gen, this.net.params.length);
    this.nn = new NetTrainer(this.net.sizes);
    this.results = files.loadResults();
  }

  async run(pool: Pool): Promise<void> {
    const startGen = this.state.gen;
    while (this.state.gen < this.config.maxGens && !this.stopRequested) {
      await this.generation(pool);
    }
    const every = this.config.publishEvery;
    if (every > 0 && this.state.gen > startGen && this.state.gen % every !== 0) this.publish();
  }

  private samplesFor(gen: number): PackedSamples | null {
    const cached = this.sampleCache.get(gen);
    if (cached) return cached;
    const loaded = this.files.loadSamples(gen);
    if (loaded) this.sampleCache.set(gen, loaded);
    return loaded;
  }

  private async generation(pool: Pool): Promise<void> {
    const { config, files } = this;
    const g = this.state.gen;
    const started = performance.now();
    const depth = depthFor(g, config.depthSchedule);
    const lambda = lambdaFor(g, config.lambda);

    const tasks = planGeneration(config, this.state);
    const nets = [...netGensUsed(tasks)].map((gen) => (gen === g ? this.net : files.loadNet(gen)));
    await pool.broadcast({ type: 'nets', nets: nets.map((n) => ({ gen: n.gen, sizes: [...n.sizes], params: n.params })) });
    let done = 0;
    const progress = process.stderr.isTTY
      ? () => process.stderr.write(`\r  gen ${g}: ${++done}/${tasks.length} tasks`)
      : undefined;
    const outputs = await pool.run(tasks.map((t) => t.req), progress);
    if (progress) process.stderr.write('\r\x1b[K');
    const secPlay = (performance.now() - started) / 1000;

    const selfplayGames: PlayedGame[] = [];
    const sampleParts: PackedSamples[] = [];
    let nodes = 0;
    let cpuSelfplay = 0;
    let cpuGauntlet = 0;
    const byOpponent = new Map<OpponentKey, { id: PlayerId; games: MatchGame[] }>();
    const byCalibration = new Map<string, { a: PlayerId; b: PlayerId; games: MatchGame[] }>();
    tasks.forEach((task, i) => {
      if (task.kind === 'selfplay') {
        const r = outputs[i] as SelfPlayResult;
        selfplayGames.push(...r.games);
        sampleParts.push(r.samples);
        nodes += r.nodes;
        cpuSelfplay += r.ms / 1000;
      } else if (task.kind === 'gauntlet') {
        cpuGauntlet += (outputs[i] as MatchResult).ms / 1000;
        const { key, id } = task.opponent!;
        const entry = byOpponent.get(key) ?? { id, games: [] };
        entry.games.push(...(outputs[i] as MatchResult).games);
        byOpponent.set(key, entry);
      } else {
        cpuGauntlet += (outputs[i] as MatchResult).ms / 1000;
        const { a, b } = task.calibration!;
        const k = `${a}:${b}`;
        const entry = byCalibration.get(k) ?? { a, b, games: [] };
        entry.games.push(...(outputs[i] as MatchResult).games);
        byCalibration.set(k, entry);
      }
    });

    const vs: Partial<Record<OpponentKey, WDL>> = {};
    const lines: ResultLine[] = [];
    const gauntletRecords: GameRecord[] = [];
    for (const [key, { id, games }] of byOpponent) {
      const wdl = tallyWdl(games);
      vs[key] = wdl;
      lines.push({ gen: g, a: g, b: id, ...wdl });
      gauntletRecords.push(...sampleMatch(games, g, key, g, id));
    }
    for (const { a, b, games } of byCalibration.values()) lines.push({ gen: g, a, b, ...tallyWdl(games) });
    const randomWdl = vs.random;
    if (randomWdl) this.state.randomPerfectStreak = randomWdl.d + randomWdl.l === 0 ? this.state.randomPerfectStreak + 1 : 0;

    const newSamples = concatSamples(sampleParts);
    this.sampleCache.set(g, newSamples);
    const bufferParts: PackedSamples[] = [];
    for (let k = Math.max(0, g - config.replayGens + 1); k <= g; k++) {
      const s = this.samplesFor(k);
      if (s) bufferParts.push(s);
    }
    for (const k of [...this.sampleCache.keys()]) if (k <= g - config.replayGens) this.sampleCache.delete(k);
    const buffer = concatSamples(bufferParts);

    const trainStarted = performance.now();
    const loss = this.nn.meanLoss(this.net.params, newSamples);
    const lr = learningRate(g, config.lr);
    const params = this.net.params.slice();
    this.nn.train(params, this.adam, buffer, {
      ...DEFAULT_TRAIN,
      lr,
      batch: config.batch,
      epochs: config.epochs,
      l2: config.l2,
      clip: config.clip,
      seed: mixSeed(config.seed, g, 0x7a1),
    });
    const lossAfter = this.nn.meanLoss(params, newSamples);
    const secTrain = (performance.now() - trainStarted) / 1000;
    const next = new Network(this.net.sizes, params, g + 1);

    this.results = [...this.results, ...lines];
    const ratings = fitElo(eloInputs(this.results));
    const mine = ratings.get(playerKey(g));
    const champion = pickChampion(g, ratings, Math.min(config.minRatedGames, mine?.games ?? 0));

    const plies = selfplayGames.reduce((n, x) => n + x.moves.length, 0);
    const decisive = selfplayGames.filter(isDecisive).length;
    const blackPoints = selfplayGames.reduce((n, x) => n + (x.result === '1-0' ? 1 : x.result === '1/2-1/2' ? 0.5 : 0), 0);
    const elapsedSec = this.state.elapsedSec + (performance.now() - started) / 1000;
    const totalGames = this.state.totalGames + selfplayGames.length;
    const stats: GenStats = {
      gen: g,
      games: selfplayGames.length,
      totalGames,
      avgPlies: selfplayGames.length ? plies / selfplayGames.length : 0,
      decisive: selfplayGames.length ? decisive / selfplayGames.length : 0,
      blackScore: selfplayGames.length ? blackPoints / selfplayGames.length : 0,
      samples: newSamples.targets.length,
      loss,
      lossAfter,
      lr,
      depth,
      lambda,
      secPlay,
      secTrain,
      cpuSelfplay,
      cpuGauntlet,
      nodes,
      vs,
      elo: mine?.elo ?? 0,
      eloErr: mine?.err ?? 0,
      hours: elapsedSec / 3600,
    };

    const sampled: SampledGames = { gen: g, selfplay: sampleSelfplay(selfplayGames, g), gauntlet: gauntletRecords };
    files.saveSamples(g, newSamples);
    files.saveGames(sampled);
    files.saveNet(next);
    files.saveAdam(g + 1, this.adam);
    files.appendResults(lines);
    files.appendStats(stats);
    this.state = {
      ...this.state,
      gen: g + 1,
      totalGames,
      elapsedSec,
      champion,
      adamStep: this.adam.step,
      updated: new Date().toISOString(),
    };
    files.saveState(this.state);
    files.pruneBefore('samples', g + 1 - config.replayGens);
    files.pruneBefore('adam', g);
    this.net = next;

    const gps = selfplayGames.length / Math.max(secPlay, 1e-9);
    console.log(
      `gen ${g}  games ${selfplayGames.length} (${gps.toFixed(1)}/s)  plies ${stats.avgPlies.toFixed(1)}  decisive ${(100 * stats.decisive).toFixed(0)}%  ` +
        `samples ${stats.samples}  loss ${loss.toFixed(4)} -> ${lossAfter.toFixed(4)}  lr ${lr}  d${depth} λ${lambda}  ` +
        `play ${secPlay.toFixed(1)}s train ${secTrain.toFixed(1)}s  elo ${stats.elo.toFixed(0)}±${stats.eloErr.toFixed(0)}  champion ${champion}`,
    );
    const perWorker = selfplayGames.length / Math.max(cpuSelfplay, 1e-9);
    console.log(
      `        ${formatWdl(vs)}  |  cpu: self-play ${cpuSelfplay.toFixed(0)}s (${perWorker.toFixed(2)} games/s/worker), gauntlet ${cpuGauntlet.toFixed(0)}s`,
    );

    if (config.publishEvery > 0 && (g + 1) % config.publishEvery === 0) this.publish();
  }

  publish(): void {
    try {
      const summary = exportRun(this.files.dir, { out: this.publishOut });
      console.log(`        published ${summary.gens} replays, ${summary.nets} nets, ${(summary.bytes / 1024).toFixed(0)} KB to ${summary.out}`);
    } catch (e) {
      console.error(`        publish failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function initRun(files: RunFiles, config: RunConfig): RunState {
  files.create(config);
  const rng = new Rng(mixSeed(config.seed, 0xbeef));
  files.saveNet(Network.random(config.layers, () => rng.next(), 0));
  const state: RunState = {
    gen: 0,
    totalGames: 0,
    elapsedSec: 0,
    randomPerfectStreak: 0,
    champion: null,
    adamStep: 0,
    updated: new Date().toISOString(),
  };
  files.saveState(state);
  return state;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args: argv, options: CLI_OPTIONS, strict: true });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const run = values.run ?? (values.smoke ? 'smoke' : 'main');
  const files = new RunFiles(runDir(run));
  let config: RunConfig;
  let state: RunState;
  if (values.resume) {
    if (!files.exists()) throw new Error(`No run at ${files.dir} to resume`);
    const saved = files.loadConfig();
    config = applyOverrides({ ...saved, gauntletDepth: saved.gauntletDepth ?? GAUNTLET_DEPTH }, values, false);
    files.saveConfig(config);
    const loaded = files.loadState();
    if (!loaded) throw new Error(`Run ${files.dir} has no state.json`);
    state = loaded;
    console.log(`resuming ${run} at generation ${state.gen} (${files.dir})`);
  } else {
    if (files.exists()) {
      const existing = files.loadConfig();
      if (!(values.smoke && existing.smoke)) {
        throw new Error(`Run ${files.dir} already exists; use --resume or pick another --run`);
      }
      files.remove();
    }
    config = applyOverrides(defaultConfig(run, values.smoke ?? false), values, true);
    state = initRun(files, config);
    console.log(`new run ${run} in ${files.dir}`);
  }
  if (state.gen >= config.maxGens) {
    console.log(`run already has ${state.gen} generations (max ${config.maxGens}); raise --max-gens to continue`);
    return;
  }

  const trainer = new Trainer(files, config, state, values['publish-out']);
  const stop = (): void => {
    if (trainer.stopRequested) {
      console.error('\nsecond interrupt: exiting without finishing the generation');
      process.exit(130);
    }
    trainer.stopRequested = true;
    console.error('\ninterrupt: finishing the current generation, then checkpointing (Ctrl-C again to abort)');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let pool: Pool | null = null;
  try {
    pool = await createPool(config.workers);
    await runWithPool(trainer, pool, config);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await pool?.close();
  }
}

async function runWithPool(trainer: Trainer, pool: Pool, config: RunConfig): Promise<void> {
  console.log(
    `${pool.mode === 'threads' ? `${pool.size} worker threads` : 'inline (no worker threads)'}; ${config.gamesPerGen} games/gen; ` +
      `depth ${config.depthSchedule.map(([g, d]) => `${g}:${d}`).join(',')} (gauntlet ${config.gauntletDepth}); max ${config.maxGens} gens`,
  );
  const started = performance.now();
  await trainer.run(pool);
  if (trainer.stopRequested) console.log('stopped cleanly; resume with --resume');
  console.log(`done in ${((performance.now() - started) / 1000).toFixed(1)}s`);
}

if (isEntryPoint(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
