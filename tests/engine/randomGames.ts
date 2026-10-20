import { applyMove, legalMoves } from '../../src/engine/movegen.ts';
import { initialPosition } from '../../src/engine/position.ts';
import { Rng } from '../../src/engine/rng.ts';
import type { Position } from '../../src/engine/types.ts';

export function* randomGamePositions(seed: number, games: number, maxPlies = 200): Generator<Position> {
  const rng = new Rng(seed);
  for (let g = 0; g < games; g++) {
    let p = initialPosition();
    for (let ply = 0; ply < maxPlies; ply++) {
      yield p;
      const moves = legalMoves(p);
      if (moves.length === 0) break;
      p = applyMove(p, rng.pick(moves));
    }
  }
}
