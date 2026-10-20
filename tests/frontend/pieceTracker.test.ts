import { describe, expect, it } from 'vitest';
import { Game } from '../../src/engine/game.ts';
import { fromFen, initialPosition } from '../../src/engine/position.ts';
import { NO_PIECE, applyMoveIds, idsAfterMoves, initialIds } from '../../src/game/pieceTracker.ts';

const occupiedIds = (ids: Int16Array) => [...ids].filter((x) => x !== NO_PIECE);

describe('pieceTracker', () => {
  it('assigns 24 distinct ids to the opening position', () => {
    const ids = initialIds(initialPosition());
    const used = occupiedIds(ids);
    expect(used).toHaveLength(24);
    expect(new Set(used).size).toBe(24);
    expect(ids[12]).toBe(NO_PIECE);
  });

  it('keeps a piece id when it moves', () => {
    const game = Game.fromMoves(['11-15']);
    const before = initialIds(initialPosition());
    const after = applyMoveIds(before, game.moves[0]);
    expect(after[14]).toBe(before[10]);
    expect(after[10]).toBe(NO_PIECE);
    expect(before[10]).not.toBe(NO_PIECE);
  });

  it('removes every captured piece in a multi-jump and keeps the jumper', () => {
    const start = fromFen('B:W14,15,22,23,24:B10');
    const game = Game.fromMoves(['10x19x28'], { startFen: 'B:W14,15,22,23,24:B10' });
    const before = initialIds(start);
    const after = applyMoveIds(before, game.moves[0]);
    expect(after[27]).toBe(before[9]);
    expect(after[14]).toBe(NO_PIECE);
    expect(after[23]).toBe(NO_PIECE);
    expect(after[13]).toBe(before[13]);
    expect(occupiedIds(after)).toHaveLength(4);
  });

  it('survives promotion', () => {
    const fen = 'B:W18,26,27:B15';
    const game = Game.fromMoves(['15x22x31'], { startFen: fen });
    const before = initialIds(fromFen(fen));
    const after = applyMoveIds(before, game.moves[0]);
    expect(after[30]).toBe(before[14]);
  });

  it('is deterministic when replaying a history, so undo restores the same ids', () => {
    const moves = ['9-13', '22-17', '13x22', '25x18', '11-15', '18x11', '7x16', '30-25'];
    const game = Game.fromMoves(moves);
    const full = idsAfterMoves(initialPosition(), game.moves);
    const partial = idsAfterMoves(initialPosition(), game.moves.slice(0, 4));
    const stepped = game.moves.slice(4).reduce(applyMoveIds, partial);
    expect([...stepped]).toEqual([...full]);
    expect(occupiedIds(full)).toHaveLength(20);
  });

  it('does not mutate its input', () => {
    const ids = initialIds(initialPosition());
    const copy = ids.slice();
    applyMoveIds(ids, Game.fromMoves(['9-13']).moves[0]);
    expect([...ids]).toEqual([...copy]);
  });
});
