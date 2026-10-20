import { afterAll, describe, expect, it } from 'vitest';
import { Rng } from '../../src/engine/index.ts';
import { Network } from '../../src/ai/network.ts';
import { InlinePool, createPool } from '../../trainer/pool.ts';
import type { Pool } from '../../trainer/pool.ts';
import { DEFAULT_SELFPLAY } from '../../trainer/selfplay.ts';
import { pairedOpenings } from '../../trainer/gauntlet.ts';
import type { MatchResult, SelfPlayResult, WorkerRequest } from '../../trainer/selfplay-worker.ts';

const rng = new Rng(12);
const net = Network.random([132, 16, 8, 1], () => rng.next());
const nets: WorkerRequest = { type: 'nets', nets: [{ gen: 3, sizes: [...net.sizes], params: net.params }] };
const tasks: WorkerRequest[] = [
  { type: 'selfplay', gen: 3, games: 2, seed: 1, options: { ...DEFAULT_SELFPLAY, depth: 1 } },
  { type: 'selfplay', gen: 3, games: 1, seed: 2, options: { ...DEFAULT_SELFPLAY, depth: 2 } },
  {
    type: 'match',
    a: { kind: 'net', gen: 3, depth: 1 },
    b: { kind: 'heuristic', depth: 1 },
    pairings: pairedOpenings(2, 5),
    seed: 3,
    maxPlies: 300,
  },
  { type: 'match', a: { kind: 'random' }, b: { kind: 'heuristic', depth: 1 }, pairings: pairedOpenings(2, 6), seed: 4, maxPlies: 300 },
];

describe('worker pool', () => {
  const pools: Pool[] = [];
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.close()));
  });

  it('runs TypeScript workers under native type stripping and matches inline results', async () => {
    const threads = await createPool(2);
    pools.push(threads);
    expect(threads.mode).toBe('threads');
    await threads.broadcast(nets);
    const done: number[] = [];
    const fromThreads = await threads.run(tasks, (i) => done.push(i));
    expect(done.sort()).toEqual([0, 1, 2, 3]);

    const inline = new InlinePool();
    await inline.broadcast(nets);
    const fromInline = await inline.run(tasks);

    const sp = fromThreads[0] as SelfPlayResult;
    expect(sp.games).toHaveLength(2);
    expect(sp.samples.targets.length * 4).toBe(sp.samples.boards.length);
    expect((fromThreads[2] as MatchResult).games).toHaveLength(2);
    const withoutTiming = (r: unknown): string => JSON.stringify(r, (key, value: unknown) => (key === 'ms' ? undefined : value));
    expect(fromThreads.map(withoutTiming)).toEqual(fromInline.map(withoutTiming));
    expect(Array.from((fromThreads[1] as SelfPlayResult).samples.targets)).toEqual(Array.from((fromInline[1] as SelfPlayResult).samples.targets));
  });

  it('reports task errors instead of hanging', async () => {
    const threads = await createPool(1);
    pools.push(threads);
    await expect(threads.run([{ type: 'selfplay', gen: 42, games: 1, seed: 1, options: DEFAULT_SELFPLAY }])).rejects.toThrow(/no weights for generation 42/);
    await threads.broadcast(nets);
    const [r] = await threads.run<SelfPlayResult>([tasks[1]]);
    expect(r.games).toHaveLength(1);
  });

  it('falls back to inline execution with zero workers', async () => {
    const pool = await createPool(0);
    expect(pool.mode).toBe('inline');
    await pool.broadcast(nets);
    const [r] = await pool.run<SelfPlayResult>([tasks[1]]);
    expect(r.games[0].moves.length).toBeGreaterThan(3);
  });
});
