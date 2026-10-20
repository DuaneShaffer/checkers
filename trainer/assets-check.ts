import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Game, TRAIN_MAX_PLIES, resultString } from '../src/engine/index.ts';
import { Network } from '../src/ai/network.ts';
import {
  CKN1_MAGIC,
  GEN_FILE_BUDGET_BYTES,
  MAX_SHIPPED_NETS,
  TRAINING_BUDGET_BYTES,
  ckn1HeaderBytes,
  ckn1ParamCount,
  isGenFile,
  isTrainingManifest,
} from '../src/shared/formats.ts';
import type { GameRecord, GenFile, TrainingManifest } from '../src/shared/formats.ts';

export interface AssetReport {
  problems: string[];
  totalBytes: number;
  gens: number;
  nets: number;
  games: number;
}

const BASELINE_IDS = new Set(['random', 'heur2', 'heur4', 'heur6']);
const OPPONENT_KEYS = new Set(['random', 'heur2', 'heur4', 'heur6', 'prev', 'prev10']);
const END_REASONS = new Set(['no-moves', 'repetition', 'no-progress', 'max-plies', 'resign', 'agreement']);
const REPLAY_PATH = /^gens\/gen-(\d{4,})\.json$/;
const NET_PATH = /^nets\/gen-(\d{4,})\.bin$/;

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isCount = (x: unknown): boolean => Number.isInteger(x) && (x as number) >= 0;
const isPlayer = (x: unknown): boolean => isCount(x) || BASELINE_IDS.has(x as string) || x === 'human';

function dirBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    total += st.isDirectory() ? dirBytes(path) : st.size;
  }
  return total;
}

function checkManifestShape(m: TrainingManifest, problems: string[]): void {
  if (typeof m.run !== 'string' || typeof m.updated !== 'string') problems.push('manifest: run/updated must be strings');
  const layers = m.net?.layers;
  if (!Array.isArray(layers) || layers.length < 2 || layers[0] !== 132 || layers[layers.length - 1] !== 1 || !layers.every((n) => Number.isInteger(n) && n > 0)) {
    problems.push(`manifest: bad net.layers ${JSON.stringify(layers)}`);
  }
  if (!isCount(m.totalGames) || !isNum(m.hours) || m.hours < 0) problems.push('manifest: totalGames/hours invalid');
  if (m.anchor?.id !== 'heur4' || m.anchor?.elo !== 1000) problems.push('manifest: anchor must be heur4 = 1000');
  for (const b of m.baselines) {
    if (!BASELINE_IDS.has(b.id) || typeof b.name !== 'string' || !isNum(b.elo)) problems.push(`manifest: bad baseline ${JSON.stringify(b)}`);
  }
  let prev = -1;
  for (const g of m.generations) {
    const where = `manifest gen ${g.gen}`;
    if (!isCount(g.gen) || g.gen <= prev) problems.push(`${where}: generations must be strictly increasing integers`);
    prev = g.gen;
    for (const key of ['games', 'hours', 'depth', 'elo', 'eloErr', 'avgPlies', 'decisive', 'loss'] as const) {
      if (!isNum(g[key])) problems.push(`${where}: ${key} must be a finite number`);
    }
    if (g.decisive < 0 || g.decisive > 1) problems.push(`${where}: decisive must be a fraction`);
    for (const [key, wdl] of Object.entries(g.vs ?? {})) {
      if (!OPPONENT_KEYS.has(key) || !wdl || !isCount(wdl.w) || !isCount(wdl.d) || !isCount(wdl.l)) {
        problems.push(`${where}: bad vs.${key} ${JSON.stringify(wdl)}`);
      }
    }
    if (g.replay !== null) {
      const match = REPLAY_PATH.exec(g.replay);
      if (!match || Number(match[1]) !== g.gen) problems.push(`${where}: bad replay path ${g.replay}`);
    }
    if (g.net !== null) {
      const match = NET_PATH.exec(g.net);
      if (!match || Number(match[1]) !== g.gen) problems.push(`${where}: bad net path ${g.net}`);
    }
  }
  if (m.champion !== null) {
    const champ = m.generations.find((g) => g.gen === m.champion);
    if (!champ) problems.push(`manifest: champion ${m.champion} is not a listed generation`);
    else if (champ.net === null) problems.push(`manifest: champion ${m.champion} has no shipped net`);
  } else if (m.generations.length > 0) {
    problems.push('manifest: champion must be set once generations exist');
  }
}

export function checkGameRecord(rec: GameRecord, where: string): string[] {
  const problems: string[] = [];
  if (rec.kind !== 'selfplay' && rec.kind !== 'gauntlet') problems.push(`${where}: bad kind ${rec.kind}`);
  if (!isPlayer(rec.black) || !isPlayer(rec.white)) problems.push(`${where}: bad players ${rec.black} vs ${rec.white}`);
  if (!END_REASONS.has(rec.reason)) problems.push(`${where}: bad reason ${rec.reason}`);
  if (!rec.moves.every((m) => typeof m === 'string')) problems.push(`${where}: moves must be strings`);
  const n = rec.moves.length;
  if (rec.evals !== undefined) {
    if (!Array.isArray(rec.evals) || rec.evals.length !== n) problems.push(`${where}: evals must have one entry per ply (${rec.evals?.length} vs ${n})`);
    else if (!rec.evals.every((e) => Number.isInteger(e) && e >= -100 && e <= 100)) problems.push(`${where}: evals must be integers in ±100`);
  }
  for (const key of ['random', 'explore'] as const) {
    const list = rec[key];
    if (list !== undefined && !(Array.isArray(list) && list.every((i) => Number.isInteger(i) && i >= 0 && i < n))) {
      problems.push(`${where}: ${key} must hold ply indices`);
    }
  }
  try {
    const game = Game.fromMoves(rec.moves, { startFen: rec.startFen, maxPlies: TRAIN_MAX_PLIES });
    const status = game.status();
    if (!status.over) {
      if (rec.reason !== 'resign' && rec.reason !== 'agreement') problems.push(`${where}: game is not over after ${n} plies but claims ${rec.reason}`);
    } else {
      if (resultString(status.winner) !== rec.result) problems.push(`${where}: result ${rec.result} but replay gives ${resultString(status.winner)}`);
      if (status.reason !== rec.reason) problems.push(`${where}: reason ${rec.reason} but replay gives ${status.reason}`);
    }
  } catch (e) {
    problems.push(`${where}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return problems;
}

function checkGenFile(dir: string, rel: string, gen: number, problems: string[]): number {
  const path = join(dir, rel);
  const size = statSync(path).size;
  if (size > GEN_FILE_BUDGET_BYTES) problems.push(`${rel}: ${size} bytes exceeds ${GEN_FILE_BUDGET_BYTES}`);
  let file: GenFile;
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as GenFile;
  } catch (e) {
    problems.push(`${rel}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
    return 0;
  }
  if (!isGenFile(file)) {
    problems.push(`${rel}: not a GenFile`);
    return 0;
  }
  if (file.gen !== gen) problems.push(`${rel}: gen ${file.gen} does not match manifest gen ${gen}`);
  const ids = new Set<string>();
  for (const rec of file.games) {
    if (ids.has(rec.id)) problems.push(`${rel}: duplicate game id ${rec.id}`);
    ids.add(rec.id);
    problems.push(...checkGameRecord(rec, `${rel} ${rec.id}`));
  }
  return file.games.length;
}

function checkNet(dir: string, rel: string, gen: number, layers: readonly number[], problems: string[]): void {
  const bytes = readFileSync(join(dir, rel));
  if (bytes.byteLength < 16 || bytes.toString('latin1', 0, 4) !== CKN1_MAGIC) {
    problems.push(`${rel}: missing CKN1 header`);
    return;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nLayers = view.getUint32(12, true);
  if (nLayers < 2 || nLayers > 16 || bytes.byteLength < ckn1HeaderBytes(nLayers)) {
    problems.push(`${rel}: bad layer count ${nLayers}`);
    return;
  }
  const sizes = Array.from({ length: nLayers }, (_, i) => view.getUint32(16 + 4 * i, true));
  const expected = ckn1HeaderBytes(nLayers) + 4 * ckn1ParamCount(sizes);
  if (bytes.byteLength !== expected) problems.push(`${rel}: ${bytes.byteLength} bytes, expected header + 4 * params = ${expected}`);
  if (sizes.join() !== layers.join()) problems.push(`${rel}: layers ${sizes.join('-')} differ from manifest ${layers.join('-')}`);
  if (view.getUint32(8, true) !== gen) problems.push(`${rel}: header gen ${view.getUint32(8, true)} does not match ${gen}`);
  try {
    Network.fromBinary(bytes);
  } catch (e) {
    problems.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function orphans(dir: string, sub: string, referenced: Set<string>): string[] {
  const path = join(dir, sub);
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => !name.startsWith('.'))
    .map((name) => `${sub}/${name}`)
    .filter((rel) => !referenced.has(rel));
}

export function checkTrainingAssets(dir: string): AssetReport {
  const report: AssetReport = { problems: [], totalBytes: 0, gens: 0, nets: 0, games: 0 };
  const { problems } = report;
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    problems.push(`missing ${manifestPath}`);
    return report;
  }
  report.totalBytes = dirBytes(dir);
  if (report.totalBytes > TRAINING_BUDGET_BYTES) problems.push(`training assets total ${report.totalBytes} bytes exceeds ${TRAINING_BUDGET_BYTES}`);
  let manifest: TrainingManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as TrainingManifest;
  } catch (e) {
    problems.push(`manifest.json: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
    return report;
  }
  if (!isTrainingManifest(manifest)) {
    problems.push('manifest.json: not a TrainingManifest');
    return report;
  }
  checkManifestShape(manifest, problems);

  const referenced = new Set<string>();
  for (const g of manifest.generations) {
    for (const rel of [g.replay, g.net]) {
      if (rel === null) continue;
      referenced.add(rel);
      if (!existsSync(join(dir, rel))) problems.push(`manifest gen ${g.gen}: missing file ${rel}`);
    }
    if (g.replay && existsSync(join(dir, g.replay)) && REPLAY_PATH.test(g.replay)) {
      report.gens++;
      report.games += checkGenFile(dir, g.replay, g.gen, problems);
    }
    if (g.net && existsSync(join(dir, g.net)) && NET_PATH.test(g.net)) {
      report.nets++;
      checkNet(dir, g.net, g.gen, manifest.net.layers, problems);
    }
  }
  if (report.nets > MAX_SHIPPED_NETS) problems.push(`${report.nets} nets shipped; at most ${MAX_SHIPPED_NETS} allowed`);
  for (const rel of [...orphans(dir, 'gens', referenced), ...orphans(dir, 'nets', referenced)]) {
    problems.push(`${rel} is not referenced by the manifest`);
  }
  return report;
}
