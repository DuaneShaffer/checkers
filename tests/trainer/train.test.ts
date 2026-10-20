import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunFiles } from '../../trainer/checkpoint.ts';
import type { GenStats } from '../../trainer/checkpoint.ts';
import { applyOverrides, defaultConfig, depthFor, main, planGeneration, selfplayChunks } from '../../trainer/train.ts';
import { exportRun } from '../../trainer/export.ts';
import { checkTrainingAssets } from '../../trainer/assets-check.ts';

const TRAIN_SCRIPT = fileURLToPath(new URL('../../trainer/train.ts', import.meta.url));
const TINY = ['--smoke', '--workers', '0', '--games-per-gen', '6', '--depth', '1', '--gauntlet-scale', '0.05'];
let root: string;
const savedRuns = process.env.CHECKERS_RUNS;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ck-train-'));
  process.env.CHECKERS_RUNS = root;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  if (savedRuns === undefined) delete process.env.CHECKERS_RUNS;
  else process.env.CHECKERS_RUNS = savedRuns;
  rmSync(root, { recursive: true, force: true });
});

const TIMING_FIELDS = new Set(['secPlay', 'secTrain', 'cpuSelfplay', 'cpuGauntlet', 'hours']);
function comparable(stats: GenStats[]): unknown[] {
  return stats.map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => !TIMING_FIELDS.has(k))));
}

describe('config and planning', () => {
  it('follows the depth schedule', () => {
    expect(depthFor(0, [[0, 4], [151, 6]])).toBe(4);
    expect(depthFor(150, [[0, 4], [151, 6]])).toBe(4);
    expect(depthFor(151, [[0, 4], [151, 6]])).toBe(6);
  });

  it('applies CLI overrides and protects seed/hidden on resume', () => {
    const base = defaultConfig('x', false);
    const c = applyOverrides(base, { workers: '3', 'depth-schedule': '0:3,10:5', hidden: '96,32', lambda: '0.8' }, true);
    expect(c.workers).toBe(3);
    expect(c.depthSchedule).toEqual([[0, 3], [10, 5]]);
    expect(c.layers).toEqual([132, 96, 32, 1]);
    expect(c.lambda).toBe(0.8);
    expect(() => applyOverrides(base, { seed: '4' }, false)).toThrow(/created/);
    expect(() => applyOverrides(base, { lambda: '2' }, true)).toThrow(/lambda/);
    expect(() => applyOverrides(base, { workers: 'many' }, true)).toThrow(/number/);
  });

  it('plans self-play chunks plus the gauntlet, with calibration only at gen 0', () => {
    const config = { ...defaultConfig('x', false), workers: 11 };
    const state = { gen: 0, totalGames: 0, elapsedSec: 0, randomPerfectStreak: 0, champion: null, adamStep: 0, updated: '' };
    const gen0 = planGeneration(config, state);
    const selfplay = gen0.filter((t) => t.kind === 'selfplay');
    expect(selfplay.reduce((n, t) => n + (t.req.type === 'selfplay' ? t.req.games : 0), 0)).toBe(2000);
    expect(new Set(selfplay.map((t) => (t.req.type === 'selfplay' ? t.req.seed : 0))).size).toBe(selfplay.length);
    expect(gen0.some((t) => t.kind === 'calibration')).toBe(true);
    const games = (tasks: typeof gen0, key: string): number =>
      tasks.filter((t) => t.opponent?.key === key).reduce((n, t) => n + (t.req.type === 'match' ? t.req.pairings.length : 0), 0);
    expect(games(gen0, 'heur4')).toBe(100);
    const gen5 = planGeneration(config, { ...state, gen: 5, randomPerfectStreak: 3 });
    expect(gen5.some((t) => t.kind === 'calibration')).toBe(false);
    expect(games(gen5, 'random')).toBe(0);
    expect(games(gen5, 'prev')).toBe(60);
    expect(games(gen5, 'heur6')).toBe(40);
  });

  it('plays the gauntlet at a fixed depth whatever the self-play depth', () => {
    const config = defaultConfig('x', false);
    const state = { gen: 151, totalGames: 0, elapsedSec: 0, randomPerfectStreak: 0, champion: null, adamStep: 0, updated: '' };
    const tasks = planGeneration(config, state);
    const selfplay = tasks.find((t) => t.req.type === 'selfplay')!.req;
    expect(selfplay.type === 'selfplay' && selfplay.options.depth).toBe(6);
    for (const { req } of tasks) {
      if (req.type !== 'match') continue;
      for (const spec of [req.a, req.b]) if (spec.kind === 'net') expect(spec.depth).toBe(4);
    }
    const prev = tasks.find((t) => t.opponent?.key === 'prev')!.req;
    expect(prev.type === 'match' && prev.b).toEqual({ kind: 'net', gen: 150, depth: 4 });
    expect(applyOverrides(config, { 'gauntlet-depth': '6' }, false).gauntletDepth).toBe(6);
  });

  it('splits self-play into shrinking chunks so workers finish together', () => {
    for (const [games, workers] of [[2000, 11], [100, 2], [7, 0], [1, 4]]) {
      const chunks = selfplayChunks(games, workers);
      expect(chunks.reduce((n, c) => n + c, 0)).toBe(games);
      expect(Math.max(...chunks)).toBeLessThanOrEqual(25);
      expect(chunks.every((c, i) => i === 0 || c <= chunks[i - 1])).toBe(true);
    }
    const big = selfplayChunks(2000, 11);
    expect(big.slice(-11).every((c) => c <= 2)).toBe(true);
    expect(big.length).toBeLessThan(200);
  });
});

describe('training runs', () => {
  it('resumes to exactly the same weights as an uninterrupted run', async () => {
    await main(['--run', 'straight', ...TINY, '--max-gens', '2']);
    await main(['--run', 'split', ...TINY, '--max-gens', '1']);
    await main(['--run', 'split', '--resume', '--max-gens', '2']);
    const a = new RunFiles(join(root, 'straight'));
    const b = new RunFiles(join(root, 'split'));
    expect(a.loadState()!.gen).toBe(2);
    expect(b.loadState()!.gen).toBe(2);
    expect(readFileSync(b.netPath(2)).equals(readFileSync(a.netPath(2)))).toBe(true);
    expect(comparable(b.loadStats())).toEqual(comparable(a.loadStats()));
    expect(b.loadResults()).toEqual(a.loadResults());
    const stats = a.loadStats();
    expect(stats.map((s) => s.gen)).toEqual([0, 1]);
    for (const s of stats) {
      expect(s.games).toBe(6);
      expect(s.samples).toBeGreaterThan(0);
      expect(Number.isFinite(s.loss) && Number.isFinite(s.lossAfter)).toBe(true);
    }

    const out = join(root, 'export-straight');
    exportRun(a.dir, { out });
    expect(checkTrainingAssets(out).problems).toEqual([]);
  }, 120_000);

  it('drops a torn trailing log line on resume', async () => {
    await main(['--run', 'torn', ...TINY, '--max-gens', '1']);
    const files = new RunFiles(join(root, 'torn'));
    appendFileSync(files.statsPath, '{"gen":1,"games":6,"tota');
    appendFileSync(files.resultsPath, '{"gen":1,"a":1,"b":"he\0\0\0');
    await main(['--run', 'torn', '--resume', '--max-gens', '2']);
    expect(files.loadStats().map((s) => s.gen)).toEqual([0, 1]);
    expect(files.loadResults().every((r) => r.gen <= 1)).toBe(true);
    expect(readFileSync(files.statsPath, 'utf8').trim().split('\n')).toHaveLength(2);
  }, 120_000);

  it('refuses to overwrite an existing non-smoke run', async () => {
    await main(['--run', 'keep', '--workers', '0', '--games-per-gen', '2', '--depth', '1', '--gauntlet-scale', '0.05', '--max-gens', '0']);
    await expect(main(['--run', 'keep', '--max-gens', '0'])).rejects.toThrow(/already exists/);
    await expect(main(['--run', 'missing', '--resume'])).rejects.toThrow(/No run/);
  });

  it('finishes the current generation on SIGINT, then resumes', async () => {
    const env = { ...process.env, CHECKERS_RUNS: root };
    const args = [TRAIN_SCRIPT, '--run', 'sig', '--smoke', '--workers', '1', '--games-per-gen', '12', '--depth', '1', '--gauntlet-scale', '0.05', '--max-gens', '500'];
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let signalled = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!signalled && /^gen 0 /m.test(stdout)) {
        signalled = true;
        child.kill('SIGINT');
      }
    });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(0);
    expect(stdout).toMatch(/stopped cleanly/);
    const files = new RunFiles(join(root, 'sig'));
    const gen = files.loadState()!.gen;
    expect(gen).toBeGreaterThanOrEqual(1);
    expect(gen).toBeLessThan(500);
    expect(files.loadStats()).toHaveLength(gen);
    expect(files.hasNet(gen)).toBe(true);

    await main(['--run', 'sig', '--resume', '--workers', '0', '--max-gens', String(gen + 1)]);
    expect(files.loadState()!.gen).toBe(gen + 1);
    expect(files.loadStats().map((s) => s.gen)).toEqual(Array.from({ length: gen + 1 }, (_, i) => i));
  }, 120_000);
});
