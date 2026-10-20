import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Game, Rng, TRAIN_MAX_PLIES, resultString } from '../../src/engine/index.ts';
import { Network } from '../../src/ai/network.ts';
import { MAX_SHIPPED_NETS } from '../../src/shared/formats.ts';
import type { GameRecord, GenFile, TrainingManifest } from '../../src/shared/formats.ts';
import { RunFiles } from '../../trainer/checkpoint.ts';
import type { GenStats, ResultLine } from '../../trainer/checkpoint.ts';
import { evenSelection, exportRun, logSpacedSelection, pickReplayGames } from '../../trainer/export.ts';
import { checkTrainingAssets } from '../../trainer/assets-check.ts';
import { defaultConfig } from '../../trainer/train.ts';

const GENS = 40;
const CHAMPION = 31;
let root: string;
let runPath: string;

function randomGame(seed: number): Omit<GameRecord, 'id' | 'kind' | 'black' | 'white'> {
  const rng = new Rng(seed);
  const game = new Game({ maxPlies: TRAIN_MAX_PLIES });
  while (!game.status().over) game.play(rng.pick(game.legalMoves()));
  const status = game.status();
  if (!status.over) throw new Error('unreachable');
  const moves = game.notation();
  return { moves, result: resultString(status.winner), reason: status.reason, evals: moves.map((_, i) => (i * 7) % 201 - 100) };
}

function eloOf(gen: number): number {
  return gen === CHAMPION ? 1400 : 600 + gen * 15;
}

function buildRun(dir: string): void {
  const files = new RunFiles(dir);
  files.create({ ...defaultConfig('fake', false), minRatedGames: 10 });
  const pool = Array.from({ length: 10 }, (_, i) => randomGame(i + 1));
  const results: ResultLine[] = [];
  for (let g = 0; g <= GENS; g++) {
    const rng = new Rng(g + 100);
    files.saveNet(Network.random([132, 64, 32, 1], () => rng.next(), g));
  }
  for (let g = 0; g < GENS; g++) {
    const score = 1 / (1 + Math.pow(10, (1000 - eloOf(g)) / 400));
    const w = Math.round(score * 100);
    results.push({ gen: g, a: g, b: 'heur4', w, d: 0, l: 100 - w });
    if (g > 0) results.push({ gen: g, a: g, b: g - 1, w: 30, d: 0, l: 30 });
    const selfplay = [0, 1, 2, 3, 4, 5].map((k) => ({ ...pool[(g + k) % pool.length], id: `sp-${g}-${k}`, kind: 'selfplay' as const, black: g, white: g }));
    const gauntlet: GameRecord[] = [
      { ...pool[(g + 6) % pool.length], id: `ga-${g}-heur2-0`, kind: 'gauntlet', black: g, white: 'heur2' },
      { ...pool[(g + 7) % pool.length], id: `ga-${g}-heur4-0`, kind: 'gauntlet', black: 'heur4', white: g },
      { ...pool[(g + 8) % pool.length], id: `ga-${g}-heur4-1`, kind: 'gauntlet', black: g, white: 'heur4' },
    ];
    if (g > 0) gauntlet.push({ ...pool[(g + 9) % pool.length], id: `ga-${g}-prev-0`, kind: 'gauntlet', black: g - 1, white: g });
    files.saveGames({ gen: g, selfplay, gauntlet });
    const stats: GenStats = {
      gen: g, games: 2000, totalGames: 2000 * (g + 1), avgPlies: 80.25, decisive: 0.4567, blackScore: 0.5, samples: 1000,
      loss: 0.0123456, lossAfter: 0.01, lr: 1e-3, depth: 4, lambda: 0.7, secPlay: 60, secTrain: 5, cpuSelfplay: 600, cpuGauntlet: 60, nodes: 1, vs: { heur4: { w, d: 0, l: 100 - w } },
      elo: 0, eloErr: 0, hours: (g + 1) * 0.03,
    };
    files.appendStats(stats);
  }
  files.appendStats({ ...JSON.parse(readFileSync(files.statsPath, 'utf8').split('\n')[0]), gen: GENS });
  files.appendResults(results);
  files.saveState({ gen: GENS, totalGames: 2000 * GENS, elapsedSec: 3600, randomPerfectStreak: 0, champion: CHAMPION, adamStep: 0, updated: '' });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ck-export-'));
  runPath = join(root, 'run');
  buildRun(runPath);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function readManifest(out: string): TrainingManifest {
  return JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as TrainingManifest;
}

describe('exportRun', () => {
  it('lets the caller pick the champion and ships its net', () => {
    const out = join(root, 'out-champion');
    exportRun(runPath, { out, champion: 12 });
    const manifest = readManifest(out);
    expect(manifest.champion).toBe(12);
    expect(manifest.generations.find((g) => g.gen === 12)?.net).not.toBeNull();
    expect(checkTrainingAssets(out).problems).toEqual([]);
    expect(() => exportRun(runPath, { out, champion: GENS + 5 })).toThrow(/not in this run/);
  });

  it('writes a manifest, replays and at most 28 log-spaced nets that pass validation', () => {
    const out = join(root, 'out-full');
    const summary = exportRun(runPath, { out, now: new Date('2026-10-20T07:00:00Z') });
    const manifest = readManifest(out);
    expect(checkTrainingAssets(out).problems).toEqual([]);
    expect(manifest.generations.map((g) => g.gen)).toEqual(Array.from({ length: GENS }, (_, i) => i));
    expect(manifest.champion).toBe(CHAMPION);
    expect(manifest.updated).toBe('2026-10-20T07:00:00.000Z');
    expect(manifest.totalGames).toBe(2000 * GENS);
    expect(manifest.baselines.map((b) => b.id)).toEqual(['heur4']);
    const shipped = manifest.generations.filter((g) => g.net !== null).map((g) => g.gen);
    expect(shipped.length).toBeLessThanOrEqual(MAX_SHIPPED_NETS);
    expect(shipped).toEqual(expect.arrayContaining([0, CHAMPION, GENS - 1]));
    expect(summary.nets).toBe(shipped.length);
    expect(readdirSync(join(out, 'nets'))).toHaveLength(shipped.length);
    const champ = manifest.generations.find((g) => g.gen === CHAMPION)!;
    expect(champ.elo).toBeGreaterThan(manifest.generations.find((g) => g.gen === CHAMPION - 1)!.elo);
    expect(manifest.generations[5].decisive).toBe(0.457);

    const gen0 = JSON.parse(readFileSync(join(out, 'gens/gen-0000.json'), 'utf8')) as GenFile;
    expect(gen0.games.filter((r) => r.kind === 'selfplay')).toHaveLength(4);
    expect(gen0.games.filter((r) => r.kind === 'gauntlet').map((r) => r.id)).toEqual(['ga-0-heur4-0', 'ga-0-heur2-0']);
    const gen7 = JSON.parse(readFileSync(join(out, 'gens/gen-0007.json'), 'utf8')) as GenFile;
    expect(gen7.games.filter((r) => r.kind === 'gauntlet').map((r) => r.id)).toEqual(['ga-7-prev-0', 'ga-7-heur4-0']);
  });

  it('removes only stale gen files and leaves everything else alone', () => {
    const out = join(root, 'out-stale');
    mkdirSync(join(out, 'gens'), { recursive: true });
    mkdirSync(join(out, 'nets'), { recursive: true });
    writeFileSync(join(out, 'gens/gen-0999.json'), '{}');
    writeFileSync(join(out, 'nets/gen-0999.bin'), 'x');
    writeFileSync(join(out, 'gens/.gitkeep'), '');
    writeFileSync(join(out, 'notes.txt'), 'keep me');
    exportRun(runPath, { out });
    expect(existsSync(join(out, 'gens/gen-0999.json'))).toBe(false);
    expect(existsSync(join(out, 'nets/gen-0999.bin'))).toBe(false);
    expect(existsSync(join(out, 'gens/.gitkeep'))).toBe(true);
    expect(readFileSync(join(out, 'notes.txt'), 'utf8')).toBe('keep me');
  });

  it('leaves the previous export untouched when the new one fails validation', () => {
    const out = join(root, 'out-guarded');
    exportRun(runPath, { out });
    const before = readFileSync(join(out, 'manifest.json'), 'utf8');
    const bad = join(root, 'bad-run');
    buildRun(bad);
    const files = new RunFiles(bad);
    const sampled = files.loadGames(3)!;
    files.saveGames({ ...sampled, selfplay: sampled.selfplay.map((r) => ({ ...r, moves: ['11-16', '9-14'] })) });
    writeFileSync(join(out, 'nets', 'gen-0999.bin'), 'stale');
    expect(() => exportRun(bad, { out, now: new Date('2030-01-01T00:00:00Z') })).toThrow(/failed validation/);
    expect(readFileSync(join(out, 'manifest.json'), 'utf8')).toBe(before);
    expect(existsSync(join(out, 'nets', 'gen-0999.bin'))).toBe(true);
    expect(readdirSync(join(out, 'gens')).every((n) => /^gen-\d{4}\.json$/.test(n))).toBe(true);
  });

  it('exports an even subset of replays when the budget is tight', () => {
    const out = join(root, 'out-budget');
    const budget = 1_400_000;
    const summary = exportRun(runPath, { out, budgetBytes: budget });
    const manifest = readManifest(out);
    const replays = manifest.generations.filter((g) => g.replay !== null).map((g) => g.gen);
    expect(replays.length).toBeLessThan(GENS);
    expect(replays.length).toBeGreaterThan(3);
    expect(replays).toEqual(expect.arrayContaining([0, CHAMPION, GENS - 1]));
    expect(summary.bytes).toBeLessThanOrEqual(budget);
    expect(checkTrainingAssets(out).problems).toEqual([]);
  });

  it('ignores generations past state.json (a crash before the checkpoint landed)', () => {
    const manifest = readManifest(join(root, 'out-full'));
    expect(manifest.generations.some((g) => g.gen === GENS)).toBe(false);
  });

  it('exports an empty run as an empty manifest', () => {
    const dir = join(root, 'empty-run');
    new RunFiles(dir).create(defaultConfig('empty', true));
    const out = join(root, 'out-empty');
    exportRun(dir, { out });
    const manifest = readManifest(out);
    expect(manifest.generations).toEqual([]);
    expect(manifest.champion).toBeNull();
    expect(checkTrainingAssets(out).problems).toEqual([]);
  });
});

describe('selection helpers', () => {
  it('log-spaces nets with gen 0, the champion and the latest included', () => {
    const all = Array.from({ length: 300 }, (_, i) => i);
    const picked = logSpacedSelection(all, [0, 187, 299], 28);
    expect(picked.length).toBeLessThanOrEqual(28);
    expect(picked.length).toBeGreaterThan(20);
    expect(picked).toEqual(expect.arrayContaining([0, 1, 2, 187, 299]));
    const early = picked.filter((g) => g < 30).length;
    const late = picked.filter((g) => g >= 150).length;
    expect(early).toBeGreaterThan(late);
  });

  it('keeps everything when under the cap', () => {
    expect(logSpacedSelection([3, 1, 2], [1], 28)).toEqual([1, 2, 3]);
  });

  it('spreads an even subset and keeps the required gens', () => {
    const all = Array.from({ length: 100 }, (_, i) => i);
    expect(evenSelection(all, [0, 57, 99], 5)).toEqual([0, 25, 50, 57, 74, 99]);
    expect(evenSelection(all, [], 200)).toHaveLength(100);
  });

  it('picks a decisive self-play game when one exists', () => {
    const rec = (id: string, result: GameRecord['result']): GameRecord => ({ id, kind: 'selfplay', black: 1, white: 1, moves: [], result, reason: 'no-moves' });
    const selfplay = [rec('a', '1/2-1/2'), rec('b', '1/2-1/2'), rec('c', '1/2-1/2'), rec('d', '1/2-1/2'), rec('e', '0-1')];
    expect(pickReplayGames(selfplay, []).map((r) => r.id)).toEqual(['a', 'b', 'c', 'e']);
  });
});
