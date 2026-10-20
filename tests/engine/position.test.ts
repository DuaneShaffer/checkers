import { describe, expect, it } from 'vitest';
import { popcount, reverseBits, rowColToSq, sqToRowCol } from '../../src/engine/bitboard.ts';
import { INITIAL_FEN, flip, fromFen, initialPosition, pieceAt, toFen } from '../../src/engine/position.ts';

describe('position basics', () => {
  it('starts with 12 pieces each, black to move', () => {
    const p = initialPosition();
    expect(popcount(p.black)).toBe(12);
    expect(popcount(p.white)).toBe(12);
    expect(p.turn).toBe(0);
    expect(pieceAt(p, 0)).toEqual({ side: 0, king: false });
    expect(pieceAt(p, 31)).toEqual({ side: 1, king: false });
    expect(pieceAt(p, 15)).toBeNull();
  });

  it('maps every square to a dark square and back', () => {
    for (let sq = 0; sq < 32; sq++) {
      const { row, col } = sqToRowCol(sq);
      expect((row + col) % 2).toBe(1);
      expect(rowColToSq(row, col)).toBe(sq);
    }
    expect(rowColToSq(0, 0)).toBeNull();
  });

  it('round-trips FEN including kings and ranges', () => {
    expect(INITIAL_FEN).toBe('B:W21,22,23,24,25,26,27,28,29,30,31,32:B1,2,3,4,5,6,7,8,9,10,11,12');
    const p = fromFen('W:WK3,21-23:B5,K30');
    expect(toFen(p)).toBe('W:WK3,21,22,23:B5,K30');
    expect(fromFen(toFen(p))).toEqual(p);
  });

  it('flip is an involution that swaps sides', () => {
    const p = fromFen('W:WK3,21-23:B5,K30');
    expect(flip(flip(p))).toEqual(p);
    expect(flip(initialPosition())).toEqual({ ...initialPosition(), turn: 1 });
    expect(reverseBits(1)).toBe(0x80000000);
  });
});
