import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { GEN_FILE_BUDGET_BYTES, MAX_SHIPPED_NETS, TRAINING_BUDGET_BYTES } from '../src/shared/formats.ts';
import type { BaselineId, GameRecord, GenFile, GenerationSummary, TrainingManifest } from '../src/shared/formats.ts';
import { checkTrainingAssets } from './assets-check.ts';
import { RunFiles, genName, isEntryPoint, runDir, writeAtomic } from './checkpoint.ts';
import type { GenStats, ResultLine } from './checkpoint.ts';
import { fitElo } from './elo.ts';
import type { Rating } from './elo.ts';
import { BASELINES, playerKey } from './gauntlet.ts';

export const DEFAULT_OUT = fileURLToPath(new URL('../public/training/', import.meta.url));
const SELFPLAY_PER_GEN = 4;
const GAUNTLET_PER_GEN = 2;
const GAUNTLET_PREFERENCE = ['prev', 'heur4', 'heur2', 'heur6', 'prev10', 'random'];
const BUDGET_HEADROOM = 0.98;
const CHAMPION_WINDOW = 20;
const BASELINE_ORDER: BaselineId[] = ['random', 'heur2', 'heur4', 'heur6'];

export interface ExportOptions {
  out?: string;
  budgetBytes?: number;
  now?: Date;
}

export interface ExportSummary {
  out: string;
  gens: number;
  nets: number;
  bytes: number;
  champion: number | null;
}

export function eloInputs(lines: readonly ResultLine[]): { a: string; b: string; w: number; d: number; l: number }[] {
  return lines.map((r) => ({ a: playerKey(r.a), b: playerKey(r.b), w: r.w, d: r.d, l: r.l }));
}

export function pickChampion(latest: number, ratings: Map<string, Rating>, minRated: number): number {
  let best = latest;
  let bestElo = -Infinity;
  for (let g = Math.max(0, latest - CHAMPION_WINDOW + 1); g <= latest; g++) {
    const r = ratings.get(playerKey(g));
    if (!r || r.games < minRated) continue;
    if (r.elo > bestElo) {
      bestElo = r.elo;
      best = g;
    }
  }
  return best;
}

export function logSpacedSelection(available: readonly number[], required: readonly number[], max: number): number[] {
  const sorted = [...new Set(available)].sort((a, b) => a - b);
  if (sorted.length <= max) return sorted;
  const have = new Set(sorted);
  const base = new Set(required.filter((g) => have.has(g)));
  const latest = sorted[sorted.length - 1];
  const nearest = (x: number): number => {
    let best = sorted[0];
    for (const g of sorted) if (Math.abs(g - x) < Math.abs(best - x)) best = g;
    return best;
  };
  let chosen = new Set(base);
  for (let points = 2; points <= 4 * sorted.length; points++) {
    const candidate = new Set(base);
    for (let i = 0; i < points; i++) candidate.add(nearest(Math.pow(latest + 1, i / (points - 1)) - 1));
    if (candidate.size > max) break;
    chosen = candidate;
    if (candidate.size === max) break;
  }
  return [...chosen].sort((a, b) => a - b);
}

export function evenSelection(all: readonly number[], required: readonly number[], count: number): number[] {
  const chosen = new Set(required.filter((g) => all.includes(g)));
  if (count >= all.length) return [...all];
  for (let i = 0; i < count; i++) {
    const at = count === 1 ? 0 : Math.round((i * (all.length - 1)) / (count - 1));
    chosen.add(all[at]);
  }
  return [...chosen].sort((a, b) => a - b);
}

function opponentKeyOf(rec: GameRecord): string {
  const m = /^ga-\d+-([a-z0-9]+)-\d+$/.exec(rec.id);
  return m ? m[1] : '';
}

export function pickReplayGames(selfplay: readonly GameRecord[], gauntlet: readonly GameRecord[]): GameRecord[] {
  const chosen: GameRecord[] = [];
  const decisive = selfplay.find((r) => r.result !== '1/2-1/2');
  if (decisive) chosen.push(decisive);
  for (const r of selfplay) {
    if (chosen.length >= SELFPLAY_PER_GEN) break;
    if (!chosen.includes(r)) chosen.push(r);
  }
  chosen.sort((a, b) => selfplay.indexOf(a) - selfplay.indexOf(b));
  const picked: GameRecord[] = [];
  for (const key of GAUNTLET_PREFERENCE) {
    if (picked.length >= GAUNTLET_PER_GEN) break;
    const games = gauntlet.filter((r) => opponentKeyOf(r) === key);
    const game = games.find((r) => r.result !== '1/2-1/2') ?? games[0];
    if (game) picked.push(game);
  }
  return [...chosen, ...picked];
}

function genFileJson(gen: number, games: GameRecord[]): string {
  let kept = games;
  for (;;) {
    const file: GenFile = { format: 1, gen, games: kept };
    const json = JSON.stringify(file);
    if (Buffer.byteLength(json) <= GEN_FILE_BUDGET_BYTES || kept.length === 0) return json;
    kept = kept.slice(0, -1);
  }
}

const round = (x: number, digits: number): number => {
  const f = Math.pow(10, digits);
  return Math.round(x * f) / f + 0;
};

function latestStats(stats: readonly GenStats[]): GenStats[] {
  const byGen = new Map<number, GenStats>();
  for (const s of stats) byGen.set(s.gen, s);
  return [...byGen.values()].sort((a, b) => a.gen - b.gen);
}

function buildManifest(
  run: string,
  layers: number[],
  stats: readonly GenStats[],
  ratings: Map<string, Rating>,
  champion: number | null,
  replays: Set<number>,
  nets: Set<number>,
  updated: string,
): TrainingManifest {
  const last = stats[stats.length - 1];
  const generations: GenerationSummary[] = stats.map((s) => {
    const r = ratings.get(playerKey(s.gen));
    return {
      gen: s.gen,
      games: s.totalGames,
      hours: round(s.hours, 3),
      depth: s.depth,
      elo: Math.round(r?.elo ?? s.elo),
      eloErr: Math.round(r?.err ?? s.eloErr),
      vs: s.vs,
      avgPlies: round(s.avgPlies, 1),
      decisive: round(s.decisive, 3),
      loss: round(s.loss, 5),
      replay: replays.has(s.gen) ? `gens/${genName(s.gen)}.json` : null,
      net: nets.has(s.gen) ? `nets/${genName(s.gen)}.bin` : null,
    };
  });
  const baselines = BASELINE_ORDER.filter((id) => (ratings.get(id)?.games ?? 0) > 0).map((id) => ({
    id,
    name: BASELINES[id].name,
    elo: Math.round(ratings.get(id)!.elo),
  }));
  return {
    format: 1,
    rules: 'english-draughts',
    run,
    updated,
    net: { layers: [...layers] },
    totalGames: last?.totalGames ?? 0,
    hours: round(last?.hours ?? 0, 3),
    champion,
    anchor: { id: 'heur4', elo: 1000 },
    baselines,
    generations,
  };
}

function removeStale(out: string, sub: 'gens' | 'nets', keep: Set<string>): void {
  const dir = join(out, sub);
  const pattern = sub === 'gens' ? /^gen-\d{4,}\.json(\.tmp-\d+)?$/ : /^gen-\d{4,}\.bin(\.tmp-\d+)?$/;
  for (const name of readdirSync(dir)) {
    if (pattern.test(name) && !keep.has(name)) rmSync(join(dir, name));
  }
}

interface ExportFiles {
  manifest: string;
  gens: Map<string, string>;
  nets: Map<string, Uint8Array>;
}

function writeExport(dir: string, files: ExportFiles, write: (path: string, data: string | Uint8Array) => void): void {
  mkdirSync(join(dir, 'gens'), { recursive: true });
  mkdirSync(join(dir, 'nets'), { recursive: true });
  for (const [name, json] of files.gens) write(join(dir, 'gens', name), json);
  for (const [name, bytes] of files.nets) write(join(dir, 'nets', name), bytes);
  write(join(dir, 'manifest.json'), files.manifest);
}

function validateStaged(files: ExportFiles): number {
  const staging = mkdtempSync(join(tmpdir(), 'checkers-export-'));
  try {
    writeExport(staging, files, writeFileSync);
    const report = checkTrainingAssets(staging);
    if (report.problems.length > 0) {
      throw new Error(`Exported assets failed validation:\n  ${report.problems.slice(0, 20).join('\n  ')}`);
    }
    return report.totalBytes;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Curates a run directory into the site's training assets; only touches manifest.json, gens/ and nets/ under out.
 * The export is validated in a staging directory first, and files land in an order that keeps
 * every manifest a concurrent reader can see pointing at complete files.
 */
export function exportRun(dir: string, options: ExportOptions = {}): ExportSummary {
  const out = resolve(options.out ?? DEFAULT_OUT);
  const budget = Math.floor((options.budgetBytes ?? TRAINING_BUDGET_BYTES) * BUDGET_HEADROOM);
  const files = new RunFiles(dir);
  if (!files.exists()) throw new Error(`No run at ${dir}`);
  const config = files.loadConfig();
  const state = files.loadState();
  const stats = latestStats(files.loadStats()).filter((s) => state === null || s.gen < state.gen);
  const ratings = fitElo(eloInputs(files.loadResults().filter((r) => state === null || r.gen < state.gen)));

  const gens = stats.map((s) => s.gen);
  const latest = gens.length ? gens[gens.length - 1] : null;
  const latestGames = latest === null ? 0 : (ratings.get(playerKey(latest))?.games ?? 0);
  const champion = latest === null ? null : pickChampion(latest, ratings, Math.min(config.minRatedGames, latestGames));
  const required = [...new Set([0, champion ?? 0, latest ?? 0])];

  const netGens = logSpacedSelection(gens.filter((g) => files.hasNet(g)), required, MAX_SHIPPED_NETS);
  const netBytes = new Map(netGens.map((g) => [g, readFileSync(files.netPath(g))]));
  const replayJson = new Map<number, string>();
  for (const g of gens) {
    const sampled = files.loadGames(g);
    if (sampled) replayJson.set(g, genFileJson(g, pickReplayGames(sampled.selfplay, sampled.gauntlet)));
  }
  const replayGens = [...replayJson.keys()];
  const updated = (options.now ?? new Date()).toISOString();

  const fixedBytes = [...netBytes.values()].reduce((n, b) => n + b.byteLength, 0);
  const sizeWith = (chosen: number[]): number => {
    const manifest = buildManifest(config.run, config.layers, stats, ratings, champion, new Set(chosen), new Set(netGens), updated);
    return fixedBytes + Buffer.byteLength(JSON.stringify(manifest)) + chosen.reduce((n, g) => n + Buffer.byteLength(replayJson.get(g)!), 0);
  };
  let chosenReplays = replayGens;
  if (sizeWith(chosenReplays) > budget) {
    let lo = 0;
    let hi = replayGens.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (sizeWith(evenSelection(replayGens, required, mid)) <= budget) lo = mid;
      else hi = mid - 1;
    }
    chosenReplays = evenSelection(replayGens, required, lo);
    if (sizeWith(chosenReplays) > budget) throw new Error(`Cannot fit training export in ${budget} bytes`);
  }

  const manifest = buildManifest(config.run, config.layers, stats, ratings, champion, new Set(chosenReplays), new Set(netGens), updated);
  const exported: ExportFiles = {
    manifest: JSON.stringify(manifest) + '\n',
    gens: new Map(chosenReplays.map((g) => [`${genName(g)}.json`, replayJson.get(g)!])),
    nets: new Map([...netBytes].map(([g, bytes]) => [`${genName(g)}.bin`, bytes])),
  };
  const bytes = validateStaged(exported);
  writeExport(out, exported, writeAtomic);
  removeStale(out, 'gens', new Set(exported.gens.keys()));
  removeStale(out, 'nets', new Set(exported.nets.keys()));
  return { out, gens: chosenReplays.length, nets: netGens.length, bytes, champion };
}

function main(): void {
  const { values } = parseArgs({
    options: { run: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } },
    strict: true,
  });
  if (values.help) {
    console.log('node trainer/export.ts [--run main] [--out public/training]');
    return;
  }
  const dir = runDir(values.run ?? 'main');
  if (values.out && !existsSync(values.out)) mkdirSync(values.out, { recursive: true });
  const summary = exportRun(dir, { out: values.out });
  console.log(
    `exported ${summary.gens} replay files and ${summary.nets} nets (${(summary.bytes / 1024).toFixed(1)} KB, champion ${summary.champion}) to ${summary.out}`,
  );
}

if (isEntryPoint(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
