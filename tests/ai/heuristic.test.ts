import { describe, expect, it } from 'vitest';
import { flip, fromFen, initialPosition } from '../../src/engine/position.ts';
import { HeuristicEvaluator, heuristicScore } from '../../src/ai/heuristic.ts';
import { randomPositions } from './helpers.ts';

describe('HeuristicEvaluator', () => {
  const ev = new HeuristicEvaluator();

  it('scores the initial position as even', () => {
    expect(ev.evaluate(initialPosition())).toBe(0);
  });

  it('is side-to-move relative and symmetric under the colour flip', () => {
    for (const p of randomPositions(31, 300)) {
      const s = ev.evaluate(p);
      expect(Number.isInteger(s)).toBe(true);
      expect(Math.abs(s)).toBeLessThanOrEqual(1000);
      expect(ev.evaluate(flip(p))).toBe(s);
    }
  });

  it('values material, with kings above men', () => {
    const up = heuristicScore(fromFen('B:W21,22,23:B9,10,11,12'));
    expect(up).toBeGreaterThan(70);
    expect(heuristicScore(fromFen('W:W21,22,23:B9,10,11,12'))).toBeLessThan(-70);
    const kingUp = heuristicScore(fromFen('B:W30:BK14,9'));
    const manUp = heuristicScore(fromFen('B:W30:B14,9'));
    expect(kingUp).toBeGreaterThan(manUp);
  });

  it('rewards back-rank guards and the centre', () => {
    expect(heuristicScore(fromFen('B:W29,31:B1,3'))).toBeGreaterThan(heuristicScore(fromFen('B:W29,31:B5,6')));
    expect(heuristicScore(fromFen('B:W30,31:B14,15'))).toBeGreaterThan(heuristicScore(fromFen('B:W30,31:B12,13')));
  });

  it('prefers trading down and chasing when ahead', () => {
    expect(heuristicScore(fromFen('B:WK1:BK18,K19,K22'))).toBeGreaterThan(heuristicScore(fromFen('B:WK1:BK28,K31,K32')));
  });

  it('clamps to ±1000', () => {
    expect(heuristicScore(fromFen('B:W32:BK1,K2,K3,K4,K5,K6,K7,K8,K9,K10,K11,K12'))).toBe(1000);
    expect(heuristicScore(fromFen('W:W32:BK1,K2,K3,K4,K5,K6,K7,K8,K9,K10,K11,K12'))).toBe(-1000);
  });
});
