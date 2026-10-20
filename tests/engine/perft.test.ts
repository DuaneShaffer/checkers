import { describe, expect, it } from 'vitest';
import { divide, perft } from '../../src/engine/perft.ts';
import { initialPosition } from '../../src/engine/position.ts';
import { legalMoves } from '../../src/engine/movegen.ts';
import { moveToString } from '../../src/engine/notation.ts';

const EXPECTED = [1, 7, 49, 302, 1469, 7361, 36768, 179740, 845931, 3963680, 18391564, 85242128];
const deep = process.env.PERFT_DEEP === '1';

describe('perft from the initial position', () => {
  it('has exactly the seven standard opening moves', () => {
    expect(legalMoves(initialPosition()).map(moveToString)).toEqual([
      '9-13', '9-14', '10-14', '10-15', '11-15', '11-16', '12-16',
    ]);
  });

  for (let depth = 0; depth <= 7; depth++) {
    it(`perft(${depth}) = ${EXPECTED[depth]}`, () => {
      expect(perft(initialPosition(), depth)).toBe(EXPECTED[depth]);
    });
  }

  it('perft(8) = 845931 in under 5 s', () => {
    const started = performance.now();
    expect(perft(initialPosition(), 8)).toBe(EXPECTED[8]);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('divide sums to perft', () => {
    const entries = divide(initialPosition(), 6);
    expect(entries.map((e) => e.move)).toEqual(legalMoves(initialPosition()).map(moveToString));
    expect(entries.reduce((sum, e) => sum + e.nodes, 0)).toBe(EXPECTED[6]);
  });

  describe.runIf(deep)('deep (PERFT_DEEP=1)', () => {
    for (let depth = 9; depth <= 11; depth++) {
      it(`perft(${depth}) = ${EXPECTED[depth]}`, { timeout: 600_000 }, () => {
        expect(perft(initialPosition(), depth)).toBe(EXPECTED[depth]);
      });
    }
  });
});
