import { applyMove, legalMoves } from '../../src/engine/movegen.ts';
import { initialPosition } from '../../src/engine/position.ts';
import { Rng } from '../../src/engine/rng.ts';
import type { Position } from '../../src/engine/types.ts';

export function randomPositions(seed: number, count: number, maxPlies = 120): Position[] {
  const rng = new Rng(seed);
  const out: Position[] = [];
  while (out.length < count) {
    let p = initialPosition();
    const plies = rng.int(maxPlies);
    for (let ply = 0; ply < plies; ply++) {
      const moves = legalMoves(p);
      if (moves.length === 0) break;
      p = applyMove(p, rng.pick(moves));
    }
    if (legalMoves(p).length > 0) out.push(p);
  }
  return out;
}
