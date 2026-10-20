import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/engine/index.ts';
import { expectedScore, fitElo } from '../../trainer/elo.ts';
import type { PairResult } from '../../trainer/elo.ts';

function simulate(truth: Record<string, number>, gamesPerPair: number, seed: number): PairResult[] {
  const rng = new Rng(seed);
  const ids = Object.keys(truth);
  const results: PairResult[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const p = expectedScore(truth[ids[i]], truth[ids[j]]);
      const drawRate = Math.min(0.3, 2 * Math.min(p, 1 - p));
      const r: PairResult = { a: ids[i], b: ids[j], w: 0, d: 0, l: 0 };
      for (let k = 0; k < gamesPerPair; k++) {
        const x = rng.next();
        if (x < p - drawRate / 2) r.w++;
        else if (x < p + drawRate / 2) r.d++;
        else r.l++;
      }
      results.push(r);
    }
  }
  return results;
}

describe('fitElo', () => {
  it('recovers synthetic ratings with heur4 anchored at 1000', () => {
    const truth = { heur4: 1000, random: 450, heur2: 780, g0: 600, g5: 1150, g9: 1320 };
    const ratings = fitElo(simulate(truth, 600, 42));
    expect(ratings.get('heur4')).toMatchObject({ elo: 1000, err: 0 });
    for (const [id, elo] of Object.entries(truth)) {
      const r = ratings.get(id)!;
      if (id !== 'heur4') {
        expect(r.err).toBeGreaterThan(0);
        expect(r.err).toBeLessThan(40);
      }
      expect(Math.abs(r.elo - elo)).toBeLessThan(3 * r.err + 10);
    }
  });

  it('recovers a chain where each player only meets its neighbours', () => {
    const truth: Record<string, number> = { heur4: 1000, g0: 700, g1: 820, g2: 900, g3: 1080, g4: 1200 };
    const order = ['g0', 'g1', 'g2', 'heur4', 'g3', 'g4'];
    const rng = new Rng(3);
    const results: PairResult[] = [];
    for (let k = 0; k + 1 < order.length; k++) {
      const [a, b] = [order[k], order[k + 1]];
      const p = expectedScore(truth[a], truth[b]);
      const r: PairResult = { a, b, w: 0, d: 0, l: 0 };
      for (let n = 0; n < 2000; n++) (rng.next() < p ? r.w++ : r.l++);
      results.push(r);
    }
    const ratings = fitElo(results);
    for (const id of order) expect(Math.abs(ratings.get(id)!.elo - truth[id])).toBeLessThan(3 * ratings.get(id)!.err + 10);
    expect(ratings.get('g0')!.err).toBeGreaterThan(ratings.get('g2')!.err);
  });

  it('treats draws as half points and swapped pairings consistently', () => {
    const a = fitElo([{ a: 'x', b: 'heur4', w: 30, d: 40, l: 10 }], { priorDraws: 0 });
    const b = fitElo([{ a: 'heur4', b: 'x', w: 10, d: 40, l: 30 }], { priorDraws: 0 });
    const expected = 1000 + 400 * Math.log10(0.625 / 0.375);
    expect(a.get('x')!.elo).toBeCloseTo(expected, 3);
    expect(b.get('x')!.elo).toBeCloseTo(expected, 3);
    expect(a.get('x')!.err).toBeCloseTo(b.get('x')!.err, 6);
  });

  it('keeps perfect scores finite through the draw prior', () => {
    const ratings = fitElo([
      { a: 'g3', b: 'random', w: 20, d: 0, l: 0 },
      { a: 'g3', b: 'heur4', w: 10, d: 20, l: 10 },
    ]);
    const random = ratings.get('random')!;
    expect(Number.isFinite(random.elo)).toBe(true);
    expect(random.elo).toBeLessThan(ratings.get('g3')!.elo - 400);
    expect(random.games).toBe(20);
    expect(ratings.get('g3')!.games).toBe(60);
  });

  it('returns only the anchor when there are no results', () => {
    const ratings = fitElo([]);
    expect([...ratings.keys()]).toEqual(['heur4']);
    expect(ratings.get('heur4')).toEqual({ elo: 1000, err: 0, games: 0 });
  });
});
