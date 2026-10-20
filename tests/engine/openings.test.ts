import { describe, expect, it } from 'vitest';
import { Game } from '../../src/engine/game.ts';
import { allOpenings } from '../../src/engine/openings.ts';

describe('openings', () => {
  it('enumerates 302 distinct legal 3-ply openings deterministically', () => {
    const openings = allOpenings(3);
    expect(openings).toHaveLength(302);
    expect(new Set(openings.map((line) => line.join(' '))).size).toBe(302);
    expect(openings[0]).toEqual(['9-13', '21-17', '5-9']);
    expect(allOpenings(3)).toEqual(openings);
    for (const line of openings) {
      expect(line).toHaveLength(3);
      expect(Game.fromMoves(line).moves).toHaveLength(3);
    }
  });

  it('matches perft counts for other depths', () => {
    expect(allOpenings(1)).toHaveLength(7);
    expect(allOpenings(2)).toHaveLength(49);
    expect(allOpenings(0)).toEqual([[]]);
  });
});
