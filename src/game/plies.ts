import { fromFen } from '../engine/position.ts';
import type { Side } from '../engine/types.ts';

export function moverOfPly(startTurn: Side, ply: number): Side {
  return (ply % 2 === 0 ? startTurn : 1 - startTurn) as Side;
}

export function hasMoveBy(game: { startFen: string; moves: readonly string[] }, sides: readonly Side[]): boolean {
  if (sides.length === 0 || game.moves.length === 0) return false;
  const startTurn = fromFen(game.startFen).turn;
  return game.moves.some((_, ply) => sides.includes(moverOfPly(startTurn, ply)));
}
