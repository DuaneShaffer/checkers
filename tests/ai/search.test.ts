import { describe, expect, it } from 'vitest';
import { Game } from '../../src/engine/game.ts';
import { applyMove, hasCapture, legalMoves } from '../../src/engine/movegen.ts';
import { moveToString } from '../../src/engine/notation.ts';
import { fromFen, initialPosition, samePosition } from '../../src/engine/position.ts';
import { mulberry32 } from '../../src/engine/rng.ts';
import type { Position } from '../../src/engine/types.ts';
import { HeuristicEvaluator } from '../../src/ai/heuristic.ts';
import { Network } from '../../src/ai/network.ts';
import { MATE_SCORE } from '../../src/ai/protocol.ts';
import {
  MATE,
  Searcher,
  createEvaluator,
  createSearcher,
  isMateScore,
  pickMove,
  type Evaluator,
  type SearchResult,
} from '../../src/ai/search.ts';
import { DEFAULT_LAYERS } from '../../src/shared/formats.ts';
import { randomPositions } from './helpers.ts';

const heuristic = new HeuristicEvaluator();
const str = (r: SearchResult): string => moveToString(r.move);

function reference(ev: Evaluator, p: Position, ply: number, depth: number): number {
  const moves = legalMoves(p);
  if (moves.length === 0) return -(MATE - ply);
  if (depth <= 0 && moves[0].captured === 0) return ev.evaluate(p) + 0;
  const childDepth = moves.length === 1 ? depth : depth - 1;
  let best = -Infinity;
  for (const m of moves) best = Math.max(best, -reference(ev, applyMove(p, m), ply + 1, childDepth));
  return best + 0;
}

function playOut(fen: string, depth: number): Game {
  const game = new Game({ startFen: fen });
  const searcher = new Searcher(heuristic, { ttBits: 16 });
  while (!game.status().over) {
    const r = searcher.search(game.position, { maxDepth: depth, history: game.historyHashes(), quietPlies: game.quietPlies });
    game.play(r.move);
  }
  return game;
}

describe('Searcher basics', () => {
  it('uses the shared mate constant', () => {
    expect(MATE).toBe(MATE_SCORE);
  });

  it('matches a plain minimax reference at shallow depth', () => {
    const searcher = new Searcher(heuristic, { ttBits: 0 });
    for (const p of randomPositions(41, 80)) {
      for (const depth of [1, 2, 3]) {
        expect(searcher.search(p, { maxDepth: depth }).score).toBe(reference(heuristic, p, 0, depth));
      }
    }
  });

  it('returns a legal move with a principal variation that starts with it', () => {
    const searcher = new Searcher(heuristic);
    const r = searcher.search(initialPosition(), { maxDepth: 6 });
    expect(legalMoves(initialPosition()).map(moveToString)).toContain(str(r));
    expect(r.depth).toBe(6);
    expect(r.nodes).toBeGreaterThan(100);
    expect(moveToString(r.pv[0])).toBe(str(r));
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('throws when there is no legal move', () => {
    expect(() => new Searcher(heuristic).search(fromFen('B:W1,5:B'), { maxDepth: 3 })).toThrow(/no legal moves/);
  });

  it('plays the only legal move', () => {
    const r = new Searcher(heuristic).search(fromFen('B:W14:B9,1'), { maxDepth: 4 });
    expect(str(r)).toBe('9x18');
  });

  it('respects node and time limits after the first iteration', () => {
    const searcher = new Searcher(heuristic);
    const byNodes = searcher.search(initialPosition(), { maxDepth: 40, nodeLimit: 5000 });
    expect(byNodes.nodes).toBeLessThan(5000 + 1100);
    expect(byNodes.depth).toBeGreaterThanOrEqual(1);
    const t0 = performance.now();
    const byTime = searcher.search(initialPosition(), { maxDepth: 40, timeMs: 60 });
    expect(performance.now() - t0).toBeLessThan(400);
    expect(byTime.depth).toBeGreaterThanOrEqual(3);
    expect(byTime.depth).toBeLessThan(40);
  });
});

describe('tactics', () => {
  it('finds a 2-for-1 shot', () => {
    const p = fromFen('B:W18,19,24,30,31:B1,3,6,10,11');
    const r = new Searcher(heuristic).search(p, { maxDepth: 6, rootScores: true });
    expect(str(r)).toBe('10-15');
    expect(r.pv.slice(0, 3).map(moveToString)).toEqual(['10-15', '19x10', '6x15x22']);
    expect(r.score).toBeGreaterThan(80);
    const others = r.rootScores!.filter((x) => moveToString(x.move) !== '10-15').map((x) => x.score);
    expect(Math.max(...others)).toBeLessThan(r.score - 80);
  });

  it('finds a sacrifice that sets up a triple jump to the crown', () => {
    const p = fromFen('B:W18,19,26,30,32:B1,3,6,10,11');
    const r = new Searcher(heuristic).search(p, { maxDepth: 6 });
    expect(str(r)).toBe('10-15');
    expect(r.pv.slice(0, 3).map(moveToString)).toEqual(['10-15', '19x10', '6x15x22x31']);
    expect(r.score).toBeGreaterThan(200);
  });

  it('finds the same shots with the threat extension on', () => {
    const p = fromFen('B:W18,19,26,30,32:B1,3,6,10,11');
    expect(str(new Searcher(heuristic).search(p, { maxDepth: 6, threatExtension: true }))).toBe('10-15');
  });

  it('scores a forced win as mate and stops early', () => {
    const p = fromFen('B:W18,19:B1,6,10,11');
    const r = new Searcher(heuristic).search(p, { maxDepth: 30 });
    expect(str(r)).toBe('10-15');
    expect(r.score).toBe(MATE - 3);
    expect(isMateScore(r.score)).toBe(true);
    expect(r.depth).toBeLessThan(30);
    expect(r.leafTerminal).toBe(true);
  });

  it('scores a forced loss as negative mate', () => {
    const p = fromFen('W:W18,19:B1,6,11,15');
    const r = new Searcher(heuristic).search(p, { maxDepth: 10 });
    expect(r.score).toBe(-(MATE - 2));
  });

  it('converts trivially won king endgames', () => {
    const cases: [string, number][] = [
      ['B:WK1:BK30,K31,K32', 6],
      ['W:WK5:BK27,K28,K32', 6],
      ['B:W25,26:B9,10,11', 8],
      ['B:WK28:BK1,K2', 10],
      ['W:WK32:BK3,K24', 10],
    ];
    for (const [fen, depth] of cases) {
      const game = playOut(fen, depth);
      expect(game.status(), fen).toEqual({ over: true, winner: 0, reason: 'no-moves' });
      expect(game.moves.length).toBeLessThan(80);
    }
  });
});

describe('transposition table', () => {
  it('gives the same score with the TT on and off at fixed depth', () => {
    const on = new Searcher(heuristic, { ttBits: 16 });
    const off = new Searcher(heuristic, { ttBits: 0 });
    let onNodes = 0;
    let offNodes = 0;
    for (const p of randomPositions(51, 150)) {
      on.clear();
      const a = on.search(p, { maxDepth: 6 });
      const b = off.search(p, { maxDepth: 6 });
      expect(a.score).toBe(b.score);
      onNodes += a.nodes;
      offNodes += b.nodes;
    }
    expect(onNodes).toBeLessThan(offNodes);
  });

  it('keeps scores consistent when the TT is warm from earlier searches', () => {
    const warm = new Searcher(heuristic, { ttBits: 16 });
    const cold = new Searcher(heuristic, { ttBits: 16 });
    for (const p of randomPositions(52, 60)) {
      warm.search(p, { maxDepth: 3 });
      cold.clear();
      expect(warm.search(p, { maxDepth: 5 }).score).toBe(cold.search(p, { maxDepth: 5 }).score);
    }
  });
});

describe('quiescence and leaves', () => {
  class CheckingEvaluator implements Evaluator {
    calls = 0;
    standPats = 0;
    evaluate(p: Position): number {
      this.calls++;
      if (hasCapture(p, p.turn)) this.standPats++;
      return heuristic.evaluate(p);
    }
  }

  it('never evaluates a position where the side to move has a capture', () => {
    const ev = new CheckingEvaluator();
    const searcher = new Searcher(ev);
    for (const p of randomPositions(61, 120)) {
      searcher.search(p, { maxDepth: 3 });
      searcher.search(p, { maxDepth: 4, threatExtension: true });
    }
    expect(ev.calls).toBeGreaterThan(1000);
    expect(ev.standPats).toBe(0);
  });

  it('resolves captures past the horizon instead of standing pat', () => {
    const p = fromFen('B:W18,27,30,31,32:B1,2,14,15');
    const r = new Searcher(heuristic).search(p, { maxDepth: 1, rootScores: true });
    const greedy = r.rootScores!.find((x) => moveToString(x.move) === '14x23')!;
    expect(greedy.score).toBeLessThan(-200);
    expect(str(r)).toBe('15x22');
    expect(r.score).toBe(reference(heuristic, p, 0, 1));
  });

  it('reports an exact, quiet PV leaf whose evaluation is the root score', () => {
    const searcher = new Searcher(heuristic);
    let checked = 0;
    for (const p of randomPositions(62, 150)) {
      const r = searcher.search(p, { maxDepth: 4 });
      expect(r.leaf).not.toBeNull();
      let q = p;
      for (const m of r.pv) q = applyMove(q, m);
      expect(samePosition(q, r.leaf!)).toBe(true);
      if (r.leafTerminal) continue;
      expect(hasCapture(r.leaf!, r.leaf!.turn)).toBe(false);
      const sign = r.leaf!.turn === p.turn ? 1 : -1;
      expect(sign * heuristic.evaluate(r.leaf!) + 0).toBe(r.score);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('keeps leaves exact with a network evaluator and a warm TT', () => {
    const net = Network.random(DEFAULT_LAYERS, mulberry32(5));
    const ev = createEvaluator(net);
    const searcher = createSearcher(net, { ttBits: 14 });
    for (const p of randomPositions(63, 60)) {
      const r = searcher.search(p, { maxDepth: 4 });
      if (r.leafTerminal) continue;
      const sign = r.leaf!.turn === p.turn ? 1 : -1;
      expect(sign * ev.evaluate(r.leaf!) + 0).toBe(r.score);
    }
  });
});

describe('draw rules inside search', () => {
  it('treats the no-progress limit as a draw', () => {
    const p = fromFen('B:WK1:BK30,K31,K32');
    const searcher = new Searcher(heuristic);
    expect(searcher.search(p, { maxDepth: 4, quietPlies: 0 }).score).toBeGreaterThan(200);
    expect(searcher.search(p, { maxDepth: 4, quietPlies: 79 }).score).toBe(0);
  });

  it('scores a move back into game history as a draw', () => {
    const game = Game.fromMoves(['30-26', '1-6', '26-30', '6-1'], { startFen: 'B:WK1:BK30,K31,K32' });
    const searcher = new Searcher(heuristic);
    const withHistory = searcher.search(game.position, { maxDepth: 3, rootScores: true, history: game.historyHashes() });
    const scoreOf = (r: SearchResult, s: string) => r.rootScores!.find((x) => moveToString(x.move) === s)!.score;
    expect(scoreOf(withHistory, '30-26')).toBe(0);
    searcher.clear();
    const fresh = searcher.search(game.position, { maxDepth: 3, rootScores: true });
    expect(scoreOf(fresh, '30-26')).toBeGreaterThan(200);
    expect(str(withHistory)).not.toBe('30-26');
  });

  it('lets the losing side steer into a repetition', () => {
    const game = Game.fromMoves(['1-5', '30-26', '5-1', '26-30'], { startFen: 'W:WK1:BK30,K31,K32' });
    const r = new Searcher(heuristic).search(game.position, { maxDepth: 1, rootScores: true, history: game.historyHashes() });
    const back = r.rootScores!.find((x) => moveToString(x.move) === '1-5')!;
    expect(back.score).toBe(0);
    expect(str(r)).toBe('1-5');
  });
});

describe('root scores and pickMove', () => {
  it('reports exact scores for every root move', () => {
    const searcher = new Searcher(heuristic, { ttBits: 0 });
    for (const p of randomPositions(71, 30)) {
      const r = searcher.search(p, { maxDepth: 3, rootScores: true });
      const moves = legalMoves(p);
      expect(r.rootScores!.length).toBe(moves.length);
      const childDepth = moves.length === 1 ? 3 : 2;
      for (const { move, score } of r.rootScores!) {
        expect(score).toBe(-reference(heuristic, applyMove(p, move), 1, childDepth) + 0);
      }
      expect(r.score).toBe(Math.max(...r.rootScores!.map((x) => x.score)));
    }
  });

  it('returns the best move at temperature 0', () => {
    const searcher = new Searcher(heuristic);
    for (const p of randomPositions(72, 20)) {
      const r = searcher.search(p, { maxDepth: 3, rootScores: true });
      const rng = mulberry32(1);
      for (let i = 0; i < 20; i++) expect(pickMove(r, { temperature: 0, blunderRate: 0 }, rng)).toBe(r.move);
    }
  });

  it('samples near-best moves with temperature and anything when blundering', () => {
    const r = new Searcher(heuristic).search(initialPosition(), { maxDepth: 4, rootScores: true });
    const rng = mulberry32(3);
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      const m = moveToString(pickMove(r, { temperature: 0.2, blunderRate: 0 }, rng));
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    expect(counts.size).toBeGreaterThan(1);
    const worst = r.rootScores!.reduce((a, b) => (b.score < a.score ? b : a));
    const best = r.rootScores!.reduce((a, b) => (b.score > a.score ? b : a));
    expect(counts.get(moveToString(best.move)) ?? 0).toBeGreaterThanOrEqual(counts.get(moveToString(worst.move)) ?? 0);

    const blunders = new Set<string>();
    for (let i = 0; i < 500; i++) blunders.add(moveToString(pickMove(r, { temperature: 0, blunderRate: 1 }, rng)));
    expect(blunders.size).toBe(7);
  });

  it('only samples moves within the margin of the best score', () => {
    const searcher = new Searcher(heuristic);
    const rng = mulberry32(5);
    for (const p of randomPositions(73, 20)) {
      const r = searcher.search(p, { maxDepth: 3, rootScores: true });
      const top = Math.max(...r.rootScores!.map((x) => x.score));
      const allowed = new Set(r.rootScores!.filter((x) => x.score >= top - 10).map((x) => moveToString(x.move)));
      for (let i = 0; i < 50; i++) {
        expect(allowed.has(moveToString(pickMove(r, { temperature: 1, blunderRate: 0, margin: 10 }, rng)))).toBe(true);
      }
    }
  });

  it('cannot randomise without root scores', () => {
    const r = new Searcher(heuristic).search(initialPosition(), { maxDepth: 2 });
    expect(r.rootScores).toBeUndefined();
    expect(pickMove(r, { temperature: 1, blunderRate: 1 }, Math.random)).toBe(r.move);
  });
});

describe('evaluators', () => {
  it('swaps evaluators and clears state', () => {
    const net = Network.random(DEFAULT_LAYERS, mulberry32(8));
    const searcher = createSearcher('heuristic');
    const a = searcher.search(initialPosition(), { maxDepth: 4 });
    searcher.setEvaluator(createEvaluator(net));
    const b = searcher.search(initialPosition(), { maxDepth: 4 });
    expect(Math.abs(b.score)).toBeLessThan(100);
    expect(a.depth).toBe(4);
    expect(b.depth).toBe(4);
  });
});
