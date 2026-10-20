import { has, squares } from '../engine/bitboard.ts';
import type { Move, Position } from '../engine/types.ts';
import type { PieceIds } from '../scene/types.ts';

export const NO_PIECE = -1;

export function initialIds(pos: Position): PieceIds {
  const ids = new Int16Array(32).fill(NO_PIECE);
  const occupied = (pos.black | pos.white) >>> 0;
  let next = 0;
  for (let sq = 0; sq < 32; sq++) if (has(occupied, sq)) ids[sq] = next++;
  return ids;
}

export function applyMoveIds(ids: PieceIds, move: Move): PieceIds {
  const out = ids.slice();
  const id = out[move.from];
  out[move.from] = NO_PIECE;
  for (const sq of squares(move.captured)) out[sq] = NO_PIECE;
  out[move.to] = id;
  return out;
}

export function idsAfterMoves(start: Position, moves: readonly Move[]): PieceIds {
  let ids = initialIds(start);
  for (const m of moves) ids = applyMoveIds(ids, m);
  return ids;
}
