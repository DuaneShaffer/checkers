import { describe, expect, it } from 'vitest';
import { legalMoves } from '../../src/engine/movegen.ts';
import { matchMove, moveToString, movesWithPrefix, parseMove } from '../../src/engine/notation.ts';
import { fromFen, initialPosition, toFen } from '../../src/engine/position.ts';
import { randomGamePositions } from './randomGames.ts';

describe('notation', () => {
  it('formats quiet moves and capture paths with 1-based squares', () => {
    expect(legalMoves(initialPosition()).map(moveToString)[0]).toBe('9-13');
    expect(legalMoves(fromFen('B:W14,23:B9')).map(moveToString)).toEqual(['9x18x27']);
  });

  it('round-trips every legal move and FEN across random games', () => {
    let checked = 0;
    for (const p of randomGamePositions(7, 150)) {
      expect(fromFen(toFen(p))).toEqual(p);
      for (const m of legalMoves(p)) {
        expect(parseMove(p, moveToString(m))).toEqual(m);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it('accepts the short from-to form for captures', () => {
    const p = fromFen('B:W14,23:B9');
    expect(moveToString(parseMove(p, '9x27')!)).toBe('9x18x27');
    expect(moveToString(parseMove(p, ' 9X18X27 ')!)).toBe('9x18x27');
  });

  it('resolves an ambiguous short capture to the first match', () => {
    const p = fromFen('B:W10,11,18,19:BK14');
    expect(moveToString(parseMove(p, '14x14')!)).toBe(moveToString(legalMoves(p)[0]));
  });

  it('rejects a short capture whose routes take different pieces', () => {
    const p = fromFen('B:W11,18,19,26,27:BK24');
    expect(legalMoves(p).map(moveToString).sort()).toEqual([
      '24x15x22x31x24',
      '24x15x8',
      '24x31x22x15x24',
      '24x31x22x15x8',
    ]);
    expect(parseMove(p, '24x8')).toBeNull();
    expect(parseMove(p, '24x24')!.captured).toBe(parseMove(p, '24x31x22x15x24')!.captured);
    expect(moveToString(parseMove(p, '24x15x8')!)).toBe('24x15x8');
    expect(moveToString(parseMove(p, '24x31x22x15x8')!)).toBe('24x31x22x15x8');
  });

  it('rejects malformed, illegal and wrongly separated moves', () => {
    const p = initialPosition();
    for (const bad of ['', '9', '9-', '9-13-17', '0-4', '33-29', '9x13', '13-17', '9--13', 'a-b', '9-14x']) {
      expect(parseMove(p, bad)).toBeNull();
    }
    expect(parseMove(fromFen('B:W14,23:B9'), '9-18')).toBeNull();
    expect(parseMove(fromFen('B:W14,23:B9'), '9x18')).toBeNull();
  });

  it('matches text against a precomputed move list', () => {
    const moves = legalMoves(initialPosition());
    expect(matchMove(moves, '11-15')).toBe(moves[4]);
    expect(matchMove(moves, '11-14')).toBeNull();
  });

  it('filters moves by a click path prefix', () => {
    const moves = legalMoves(fromFen('B:W10,11,18,19:BK14'));
    expect(movesWithPrefix(moves, [13])).toHaveLength(2);
    expect(movesWithPrefix(moves, [13, 6]).map(moveToString)).toEqual(['14x7x16x23x14']);
    expect(movesWithPrefix(moves, [13, 6, 15, 22, 13, 6])).toHaveLength(0);
    expect(movesWithPrefix(legalMoves(initialPosition()), [9])).toHaveLength(2);
  });
});
