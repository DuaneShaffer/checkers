import { applyMove, legalMoves } from './movegen.ts';
import { moveToString } from './notation.ts';
import { initialPosition } from './position.ts';
import type { Position } from './types.ts';

function extend(p: Position, plies: number, line: string[], out: string[][]): void {
  if (plies === 0) {
    out.push(line.slice());
    return;
  }
  for (const m of legalMoves(p)) {
    line.push(moveToString(m));
    extend(applyMove(p, m), plies - 1, line, out);
    line.pop();
  }
}

export function allOpenings(plies = 3, start: Position = initialPosition()): string[][] {
  const out: string[][] = [];
  extend(start, plies, [], out);
  return out;
}
