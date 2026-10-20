import { describe, expect, it } from 'vitest';
import { applyMove, capturedSquares, hasCapture, jumpedSquare, jumpedSquareOrNull, legalMoves } from '../../src/engine/movegen.ts';
import { moveToString } from '../../src/engine/notation.ts';
import { fromFen, pieceAt, toFen } from '../../src/engine/position.ts';
import type { Sq } from '../../src/engine/types.ts';

const movesOf = (fen: string): string[] => legalMoves(fromFen(fen)).map(moveToString).sort();
const mask = (...pdn: number[]): number => pdn.reduce((b, n) => (b | (1 << (n - 1))) >>> 0, 0);
const pdn = (squares: readonly Sq[]): number[] => squares.map((sq) => sq + 1);

describe('mandatory capture', () => {
  it('forces a capture over quiet moves', () => {
    expect(movesOf('B:W14:B9,12')).toEqual(['9x18']);
  });

  it('reports captures per side', () => {
    expect(hasCapture(fromFen('B:W14:B9,12'), 0)).toBe(true);
    expect(hasCapture(fromFen('B:W14:B9,12'), 1)).toBe(true);
    expect(hasCapture(fromFen('B:W14:B5,9'), 1)).toBe(false);
  });

  it('allows any capture, not only the longest', () => {
    expect(movesOf('B:W6,15,16:B1,12')).toEqual(['12x19', '1x10x19']);
  });

  it('requires multi-jumps to be completed', () => {
    expect(movesOf('B:W14,23:B9')).toEqual(['9x18x27']);
  });
});

describe('direction rules', () => {
  it('black men cannot capture backwards', () => {
    expect(movesOf('B:W14:B18')).toEqual(['18-22', '18-23']);
    expect(hasCapture(fromFen('B:W14:B18'), 0)).toBe(false);
  });

  it('white men cannot capture backwards', () => {
    expect(movesOf('W:W14:B18')).toEqual(['14-10', '14-9']);
  });

  it('kings capture backwards', () => {
    expect(movesOf('B:W14:BK18')).toEqual(['18x9']);
  });

  it('kings move one square in every diagonal direction', () => {
    expect(movesOf('B:W1:BK14')).toEqual(['14-10', '14-17', '14-18', '14-9']);
  });
});

describe('promotion', () => {
  it('crowns a man that reaches the far row', () => {
    const p = fromFen('B:W1:B27');
    const moves = legalMoves(p);
    expect(moves.map(moveToString).sort()).toEqual(['27-31', '27-32']);
    expect(moves.every((m) => m.promotes)).toBe(true);
    expect(pieceAt(applyMove(p, moves[0]), moves[0].to)).toEqual({ side: 0, king: true });
  });

  it('ends a capture when a man is crowned', () => {
    const moves = legalMoves(fromFen('B:W26,27:B22'));
    expect(moves.map(moveToString)).toEqual(['22x31']);
    expect(moves[0].promotes).toBe(true);
    expect(moves[0].captured).toBe(mask(26));
  });

  it('lets an existing king continue through the far row', () => {
    const moves = legalMoves(fromFen('B:W26,27:BK22'));
    expect(moves.map(moveToString)).toEqual(['22x31x24']);
    expect(moves[0].promotes).toBe(false);
  });

  it('crowns white men on squares 1-4', () => {
    const moves = legalMoves(fromFen('W:W7:B10'));
    expect(moves.map(moveToString).sort()).toEqual(['7-2', '7-3']);
    expect(moves.every((m) => m.promotes)).toBe(true);
  });
});

describe('king capture sequences', () => {
  const LOOP = 'B:W10,11,18,19:BK14';

  it('can loop back to its origin square, keeping both directions', () => {
    const moves = legalMoves(fromFen(LOOP));
    expect(moves.map(moveToString).sort()).toEqual(['14x23x16x7x14', '14x7x16x23x14']);
    for (const m of moves) {
      expect(m.from).toBe(m.to);
      expect(m.captured).toBe(mask(10, 11, 18, 19));
    }
  });

  it('keeps the king on its origin after a loop', () => {
    const p = fromFen(LOOP);
    const after = applyMove(p, legalMoves(p)[0]);
    expect(toFen(after)).toBe('W:W:BK14');
  });

  it('never jumps the same piece twice', () => {
    expect(movesOf('B:W18:BK14')).toEqual(['14x23']);
  });

  it('lists captured squares in hop order', () => {
    const m = legalMoves(fromFen(LOOP)).find((x) => moveToString(x) === '14x7x16x23x14')!;
    expect(pdn(capturedSquares(m))).toEqual([10, 11, 19, 18]);
    expect(jumpedSquare(13, 6) + 1).toBe(10);
    expect(() => jumpedSquare(13, 17)).toThrow();
    expect(jumpedSquareOrNull(13, 6)).toBe(9);
    expect(jumpedSquareOrNull(13, 17)).toBeNull();
    expect(jumpedSquareOrNull(0, 4)).toBeNull();
  });
});

describe('applyMove', () => {
  it('removes captured pieces and moves the mover', () => {
    const p = fromFen('B:W14,23:B9');
    expect(toFen(applyMove(p, legalMoves(p)[0]))).toBe('W:W:B27');
  });

  it('removes captured kings', () => {
    const p = fromFen('W:WK18:BK14,K21');
    const moves = legalMoves(p);
    expect(moves.map(moveToString)).toEqual(['18x9']);
    expect(toFen(applyMove(p, moves[0]))).toBe('B:WK9:BK21');
  });
});
