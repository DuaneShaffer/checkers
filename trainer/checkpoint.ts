import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Network } from '../src/ai/network.ts';
import type { GameRecord, OpponentKey, PlayerId, WDL } from '../src/shared/formats.ts';
import { Adam } from './nn-train.ts';
import type { PackedSamples } from './selfplay.ts';

export interface RunConfig {
  run: string;
  smoke: boolean;
  seed: number;
  layers: number[];
  gamesPerGen: number;
  workers: number;
  depthSchedule: [number, number][];
  gauntletDepth: number;
  lambda: number | null;
  lr: number;
  epsilon: number;
  softmaxPlies: number;
  temperature: number;
  batch: number;
  epochs: number;
  replayGens: number;
  l2: number;
  clip: number;
  maxPlies: number;
  gauntletScale: number;
  maxGens: number;
  publishEvery: number;
  minRatedGames: number;
  createdAt: string;
}

export interface RunState {
  gen: number;
  totalGames: number;
  elapsedSec: number;
  randomPerfectStreak: number;
  champion: number | null;
  adamStep: number;
  updated: string;
}

export interface GenStats {
  gen: number;
  games: number;
  totalGames: number;
  avgPlies: number;
  decisive: number;
  blackScore: number;
  samples: number;
  loss: number;
  lossAfter: number;
  lr: number;
  depth: number;
  lambda: number;
  secPlay: number;
  secTrain: number;
  cpuSelfplay: number;
  cpuGauntlet: number;
  nodes: number;
  vs: Partial<Record<OpponentKey, WDL>>;
  elo: number;
  eloErr: number;
  hours: number;
}

export interface ResultLine {
  gen: number;
  a: PlayerId;
  b: PlayerId;
  w: number;
  d: number;
  l: number;
}

export interface SampledGames {
  gen: number;
  selfplay: GameRecord[];
  gauntlet: GameRecord[];
}

export function isEntryPoint(moduleUrl: string): boolean {
  return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(moduleUrl);
}

export function runsRoot(): string {
  return process.env.CHECKERS_RUNS || join(homedir(), 'checkers-runs');
}

export function runDir(run: string): string {
  if (!/^[\w.-]+$/.test(run)) throw new Error(`Invalid run name "${run}"`);
  return join(runsRoot(), run);
}

export function genName(gen: number): string {
  return `gen-${String(gen).padStart(4, '0')}`;
}

export function writeAtomic(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function toBytes(buf: ArrayBuffer): Uint8Array {
  return new Uint8Array(buf);
}

export class RunFiles {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  get configPath(): string { return join(this.dir, 'config.json'); }
  get statePath(): string { return join(this.dir, 'state.json'); }
  get statsPath(): string { return join(this.dir, 'stats.jsonl'); }
  get resultsPath(): string { return join(this.dir, 'results.jsonl'); }
  netPath(gen: number): string { return join(this.dir, 'nets', `${genName(gen)}.bin`); }
  adamPath(gen: number): string { return join(this.dir, 'adam', `${genName(gen)}.bin`); }
  samplesPath(gen: number): string { return join(this.dir, 'samples', `${genName(gen)}.bin`); }
  gamesPath(gen: number): string { return join(this.dir, 'games', `${genName(gen)}.json`); }

  exists(): boolean {
    return existsSync(this.configPath);
  }

  create(config: RunConfig): void {
    for (const sub of ['nets', 'adam', 'samples', 'games']) mkdirSync(join(this.dir, sub), { recursive: true });
    writeAtomic(this.configPath, JSON.stringify(config, null, 2) + '\n');
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  loadConfig(): RunConfig {
    return readJson<RunConfig>(this.configPath);
  }

  saveConfig(config: RunConfig): void {
    writeAtomic(this.configPath, JSON.stringify(config, null, 2) + '\n');
  }

  loadState(): RunState | null {
    return existsSync(this.statePath) ? readJson<RunState>(this.statePath) : null;
  }

  saveState(state: RunState): void {
    writeAtomic(this.statePath, JSON.stringify(state, null, 2) + '\n');
  }

  saveNet(net: Network): void {
    writeAtomic(this.netPath(net.gen), toBytes(net.toBinary()));
  }

  loadNet(gen: number): Network {
    return Network.fromBinary(readFileSync(this.netPath(gen)));
  }

  hasNet(gen: number): boolean {
    return existsSync(this.netPath(gen));
  }

  saveAdam(gen: number, adam: Adam): void {
    const n = adam.m.length;
    const buf = new ArrayBuffer(16 + 16 * n);
    const view = new DataView(buf);
    view.setUint32(0, 0x4d414441, true);
    view.setUint32(4, n, true);
    view.setFloat64(8, adam.step, true);
    new Float64Array(buf, 16, n).set(adam.m);
    new Float64Array(buf, 16 + 8 * n, n).set(adam.v);
    writeAtomic(this.adamPath(gen), toBytes(buf));
  }

  loadAdam(gen: number, size: number): Adam {
    const path = this.adamPath(gen);
    if (!existsSync(path)) return new Adam(size);
    const bytes = readFileSync(path);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const view = new DataView(buf);
    const n = view.getUint32(4, true);
    if (view.getUint32(0, true) !== 0x4d414441 || n !== size) throw new Error(`Bad Adam checkpoint ${path}`);
    return new Adam(size, new Float64Array(buf, 16, n).slice(), new Float64Array(buf, 16 + 8 * n, n).slice(), view.getFloat64(8, true));
  }

  saveSamples(gen: number, samples: PackedSamples): void {
    const n = samples.targets.length;
    const buf = new ArrayBuffer(4 + 20 * n);
    const view = new DataView(buf);
    view.setUint32(0, n, true);
    new Uint32Array(buf, 4, 4 * n).set(samples.boards);
    new Float32Array(buf, 4 + 16 * n, n).set(samples.targets);
    writeAtomic(this.samplesPath(gen), toBytes(buf));
  }

  loadSamples(gen: number): PackedSamples | null {
    const path = this.samplesPath(gen);
    if (!existsSync(path)) return null;
    const bytes = readFileSync(path);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const n = new DataView(buf).getUint32(0, true);
    return { boards: new Uint32Array(buf, 4, 4 * n).slice(), targets: new Float32Array(buf, 4 + 16 * n, n).slice() };
  }

  saveGames(games: SampledGames): void {
    writeAtomic(this.gamesPath(games.gen), JSON.stringify(games));
  }

  loadGames(gen: number): SampledGames | null {
    const path = this.gamesPath(gen);
    return existsSync(path) ? readJson<SampledGames>(path) : null;
  }

  appendStats(stats: GenStats): void {
    appendFileSync(this.statsPath, JSON.stringify(stats) + '\n');
  }

  appendResults(lines: readonly ResultLine[]): void {
    if (lines.length > 0) appendFileSync(this.resultsPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  loadStats(): GenStats[] {
    return readJsonl<GenStats>(this.statsPath);
  }

  loadResults(): ResultLine[] {
    return readJsonl<ResultLine>(this.resultsPath);
  }

  /** Drops log lines (including torn ones) written by a generation that crashed before its state.json landed. */
  truncateLogs(nextGen: number): void {
    for (const path of [this.statsPath, this.resultsPath]) {
      if (!existsSync(path)) continue;
      const kept = readJsonl<{ gen: number }>(path).filter((l) => Number.isInteger(l.gen) && l.gen < nextGen);
      writeAtomic(path, kept.map((l) => JSON.stringify(l) + '\n').join(''));
    }
  }

  pruneBefore(sub: 'adam' | 'samples', keepFrom: number): void {
    const dir = join(this.dir, sub);
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const m = /^gen-(\d{4,})\.bin$/.exec(name);
      if (m && Number(m[1]) < keepFrom) rmSync(join(dir, name));
    }
  }
}

function parseLine<T>(line: string): T | null {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === 'object' ? (value as T) : null;
  } catch {
    return null;
  }
}

/** Skips unparsable lines: a hard crash can leave a torn or NUL-padded tail. */
export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.replace(/\0/g, '').trim();
    const value = line.length > 0 ? parseLine<T>(line) : null;
    if (value !== null) out.push(value);
  }
  return out;
}
