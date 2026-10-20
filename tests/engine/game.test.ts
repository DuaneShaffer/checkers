import { describe, expect, it } from 'vitest';
import { Game, IllegalMoveError, resultString } from '../../src/engine/game.ts';
import { applyMove, hasCapture, legalMoves } from '../../src/engine/movegen.ts';
import { moveToString } from '../../src/engine/notation.ts';
import { INITIAL_FEN, toFen } from '../../src/engine/position.ts';
import { Rng } from '../../src/engine/rng.ts';
import { NO_PROGRESS_PLIES } from '../../src/engine/types.ts';
import { hashOf } from '../../src/engine/zobrist.ts';

const KING_SHUFFLE = ['1-6', '32-27', '6-1', '27-32'];

function playUntilOver(game: Game, lines: string[]): void {
  for (const m of lines) game.play(m);
}

describe('Game basics', () => {
  it('starts from the initial position with a normalized FEN', () => {
    const game = new Game();
    expect(game.startFen).toBe(INITIAL_FEN);
    expect(new Game({ startFen: 'B:W21-32:B1-12' }).startFen).toBe(INITIAL_FEN);
    expect(game.legalMoves()).toHaveLength(7);
    expect(game.status()).toEqual({ over: false });
  });

  it('plays strings and Move objects and records notation', () => {
    const game = new Game();
    game.play('11-15');
    const reply = legalMoves(game.position).find((m) => moveToString(m) === '23-19')!;
    expect(game.play({ ...reply, path: [...reply.path] })).toBe(game.moves[1]);
    expect(game.notation()).toEqual(['11-15', '23-19']);
    expect(game.position.turn).toBe(0);
  });

  it('rejects illegal moves', () => {
    const game = new Game();
    expect(() => game.play('11-16x')).toThrow();
    expect(() => game.play('21-17')).toThrow();
    expect(() => game.play({ from: 8, to: 17, path: [8, 17], captured: 0, promotes: false })).toThrow();
    expect(game.moves).toHaveLength(0);
  });

  it('undoes moves back to the start', () => {
    const game = Game.fromMoves(['11-15', '23-19', '8-11']);
    expect(moveToString(game.undo()!)).toBe('8-11');
    expect(game.notation()).toEqual(['11-15', '23-19']);
    game.undo();
    game.undo();
    expect(game.undo()).toBeUndefined();
    expect(toFen(game.position)).toBe(INITIAL_FEN);
    expect(game.legalMoves()).toHaveLength(7);
  });

  it('round-trips random games through fromMoves', () => {
    const rng = new Rng(5);
    for (let g = 0; g < 20; g++) {
      const game = new Game();
      while (!game.status().over && game.ply < 120) game.play(rng.pick(game.legalMoves()));
      const replay = Game.fromMoves(game.notation(), { startFen: game.startFen });
      expect(replay.position).toEqual(game.position);
      expect(replay.status()).toEqual(game.status());
      expect(Array.from(replay.historyHashes())).toEqual(Array.from(game.historyHashes()));
    }
  });

  it('fromMoves throws with the index of the bad move', () => {
    const attempt = (moves: string[]): IllegalMoveError => {
      try {
        Game.fromMoves(moves);
      } catch (e) {
        return e as IllegalMoveError;
      }
      throw new Error('expected fromMoves to throw');
    };
    const malformed = attempt(['11-15', '23-19', 'nonsense']);
    expect(malformed).toBeInstanceOf(IllegalMoveError);
    expect(malformed.index).toBe(2);
    expect(malformed.move).toBe('nonsense');
    expect(attempt(['11-15', '11-15']).index).toBe(1);
    expect(attempt(['11-15', '22-18', '10-14']).index).toBe(2);
    expect(attempt([...KING_SHUFFLE, ...KING_SHUFFLE, '1-6']).index).toBe(0);
    const kings = { startFen: 'B:WK32:BK1' };
    expect(() => Game.fromMoves([...KING_SHUFFLE, ...KING_SHUFFLE, '1-6'], kings)).toThrow(/index 8/);
    const ambiguous = { startFen: 'B:W11,18,19,26,27:BK24' };
    expect(() => Game.fromMoves(['24x8'], ambiguous)).toThrow(/index 0 .*unambiguous/);
    expect(() => new Game(ambiguous).play('24x8')).toThrow(/ambiguous/);
  });

  it('formats results', () => {
    expect(resultString(0)).toBe('1-0');
    expect(resultString(1)).toBe('0-1');
    expect(resultString(null)).toBe('1/2-1/2');
  });
});

describe('Game end conditions', () => {
  it('the side to move loses when blocked', () => {
    const game = new Game({ startFen: 'W:W5:B1' });
    expect(game.status()).toEqual({ over: true, winner: 0, reason: 'no-moves' });
  });

  it('the side to move loses with no pieces', () => {
    const game = new Game({ startFen: 'B:W14:B9' });
    game.play('9x18');
    expect(game.status()).toEqual({ over: true, winner: 0, reason: 'no-moves' });
    expect(() => game.play('18-22')).toThrow(/over/);
  });

  it('draws on threefold repetition with the same side to move', () => {
    const game = new Game({ startFen: 'B:WK32:BK1' });
    playUntilOver(game, KING_SHUFFLE);
    expect(game.status().over).toBe(false);
    playUntilOver(game, KING_SHUFFLE.slice(0, 3));
    expect(game.status().over).toBe(false);
    game.play(KING_SHUFFLE[3]);
    expect(game.status()).toEqual({ over: true, winner: null, reason: 'repetition' });
    game.undo();
    expect(game.status().over).toBe(false);
  });

  it('exposes hash pairs for positions since the last irreversible move', () => {
    const game = new Game({ startFen: 'B:WK32:BK1,9' });
    expect(Array.from(game.historyHashes())).toEqual(hashOf(game.position));
    game.play('1-6');
    game.play('32-27');
    const history = game.historyHashes();
    expect(history).toHaveLength(6);
    expect(Array.from(history.subarray(4))).toEqual(hashOf(game.position));
    game.play('9-13');
    expect(game.quietPlies).toBe(0);
    expect(Array.from(game.historyHashes())).toEqual(hashOf(game.position));
  });

  it('draws after 80 plies without a man move or capture', () => {
    const game = new Game({ startFen: 'B:WK29,K32:BK1,K4' });
    const seen = new Map<string, number>();
    const visit = (fen: string): void => void seen.set(fen, (seen.get(fen) ?? 0) + 1);
    visit(toFen(game.position));
    for (let ply = 0; ply < NO_PROGRESS_PLIES; ply++) {
      expect(game.status().over).toBe(false);
      const safe = game
        .legalMoves()
        .filter((m) => m.captured === 0 && !hasCapture(applyMove(game.position, m), (1 - game.position.turn) as 0 | 1));
      const best = safe.reduce((a, b) =>
        (seen.get(toFen(applyMove(game.position, b))) ?? 0) < (seen.get(toFen(applyMove(game.position, a))) ?? 0) ? b : a,
      );
      game.play(best);
      visit(toFen(game.position));
      expect(game.quietPlies).toBe(ply + 1);
    }
    expect(game.status()).toEqual({ over: true, winner: null, reason: 'no-progress' });
  });

  it('a man move resets the no-progress counter', () => {
    const game = new Game({ startFen: 'B:WK32:BK1,9' });
    game.play('1-6');
    game.play('32-27');
    expect(game.quietPlies).toBe(2);
    game.play('9-13');
    expect(game.quietPlies).toBe(0);
  });

  it('draws at maxPlies when configured', () => {
    const game = new Game({ maxPlies: 4 });
    playUntilOver(game, ['11-15', '23-19', '8-11']);
    expect(game.status().over).toBe(false);
    game.play('22-17');
    expect(game.status()).toEqual({ over: true, winner: null, reason: 'max-plies' });
    expect(() => game.play('9-13')).toThrow(/over/);
    expect(new Game().status().over).toBe(false);
  });

  it('prefers a win over a simultaneous draw condition', () => {
    const game = new Game({ startFen: 'B:W14:B9', maxPlies: 1 });
    game.play('9x18');
    expect(game.status()).toEqual({ over: true, winner: 0, reason: 'no-moves' });
  });
});
