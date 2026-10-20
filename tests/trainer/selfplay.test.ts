import { describe, expect, it } from 'vitest';
import { Game, Rng, TRAIN_MAX_PLIES, legalMoves, resultString } from '../../src/engine/index.ts';
import { NetEvaluator, Network } from '../../src/ai/network.ts';
import { HeuristicEvaluator } from '../../src/ai/heuristic.ts';
import { Searcher } from '../../src/ai/search.ts';
import { DEFAULT_SELFPLAY, blackValueOfLeaf, packSamples, playSelfPlayGame } from '../../trainer/selfplay.ts';
import type { PlayedGame } from '../../trainer/selfplay.ts';
import { gauntletOpponents, openings, pairedOpenings, playMatchGame, scaledGames, scoreFor, tallyWdl } from '../../trainer/gauntlet.ts';
import { checkGameRecord } from '../../trainer/assets-check.ts';

function replay(g: PlayedGame): Game {
  return Game.fromMoves(g.moves, { maxPlies: TRAIN_MAX_PLIES });
}

function expectConsistent(g: PlayedGame): void {
  const game = replay(g);
  const status = game.status();
  expect(status.over).toBe(true);
  if (status.over) {
    expect(resultString(status.winner)).toBe(g.result);
    expect(status.reason).toBe(g.reason);
  }
  expect(g.evals).toHaveLength(g.moves.length);
  for (const e of g.evals) {
    expect(Number.isInteger(e)).toBe(true);
    expect(Math.abs(e)).toBeLessThanOrEqual(100);
  }
}

describe('playSelfPlayGame', () => {
  const rng = new Rng(17);
  const net = Network.random([132, 32, 16, 1], () => rng.next());
  for (let i = 0; i < net.params.length; i++) net.params[i] *= 3;
  const searcher = new Searcher(new NetEvaluator(net), { ttBits: 14 });

  it('plays a legal game that matches its recorded result, with samples on leaf positions', () => {
    const opening = openings()[123];
    const gameRng = new Rng(5);
    const g = playSelfPlayGame(net, searcher, opening, () => gameRng.next(), { ...DEFAULT_SELFPLAY, depth: 2 });
    expectConsistent(g);
    expect(g.moves.slice(0, 3)).toEqual(opening);
    expect(g.random.slice(0, 3)).toEqual([0, 1, 2]);
    for (const ply of g.explore) expect(g.random).not.toContain(ply);
    expect(g.targets.length).toBe(g.leaves.length);
    expect(g.targets.length).toBeLessThanOrEqual(g.moves.length - g.random.length - g.explore.length);
    expect(g.targets.length).toBeGreaterThan(0);
    for (const t of g.targets) expect(Math.abs(t)).toBeLessThanOrEqual(1);
    for (const leaf of g.leaves) expect(legalMoves(leaf).length).toBeGreaterThan(0);
    expect(g.nodes).toBeGreaterThan(g.moves.length);
  });

  it('is deterministic for a seed', () => {
    const play = (): PlayedGame => {
      const r = new Rng(99);
      return playSelfPlayGame(net, searcher, openings()[7], () => r.next(), { ...DEFAULT_SELFPLAY, depth: 2 });
    };
    expect(play().moves).toEqual(play().moves);
  });

  it('at ε = 1 explores every ply that has a choice, leaving samples only on forced moves', () => {
    const r = new Rng(3);
    const g = playSelfPlayGame(net, searcher, openings()[50], () => r.next(), {
      ...DEFAULT_SELFPLAY,
      depth: 1,
      epsilon: 1,
      softmaxPlies: 0,
      extraRandomProb: 1,
    });
    expectConsistent(g);
    const game = new Game({ maxPlies: TRAIN_MAX_PLIES });
    let forced = 0;
    g.moves.forEach((move, ply) => {
      if (!g.random.includes(ply) && !g.explore.includes(ply)) {
        expect(game.legalMoves()).toHaveLength(1);
        forced++;
      }
      game.play(move);
    });
    expect(g.explore.length).toBeGreaterThan(10);
    expect(g.targets.length).toBeLessThanOrEqual(forced);
  });

  it('packs samples as four words plus a target each', () => {
    const r = new Rng(1);
    const g = playSelfPlayGame(net, searcher, openings()[0], () => r.next(), { ...DEFAULT_SELFPLAY, depth: 1 });
    const packed = packSamples([g]);
    expect(packed.boards.length).toBe(4 * g.targets.length);
    expect(packed.boards[3]).toBe(g.leaves[0].turn);
    expect(packed.targets[0]).toBeCloseTo(g.targets[0], 6);
  });

  it('values terminal leaves exactly', () => {
    const lost = { black: 0, white: 1 << 20, kings: 0, turn: 0 as const };
    const result = { leaf: lost, leafTerminal: true } as Parameters<typeof blackValueOfLeaf>[1];
    expect(blackValueOfLeaf(net, result, lost)).toMatchObject({ value: -1, terminal: true });
    const whiteLost = { black: 1, white: 0, kings: 0, turn: 1 as const };
    expect(blackValueOfLeaf(net, { ...result, leaf: whiteLost }, whiteLost).value).toBe(1);
  });
});

describe('gauntlet', () => {
  it('plans the standard opponents with prev10 and heur6 every fifth generation', () => {
    const keys = (gen: number, dropRandom = false): string[] =>
      gauntletOpponents(gen, { depth: 4, scale: 1, dropRandom }).map((o) => `${o.key}:${o.games}`);
    expect(keys(0)).toEqual(['random:20', 'heur2:40', 'heur4:100']);
    expect(keys(1)).toEqual(['random:20', 'heur2:40', 'heur4:100', 'prev:60']);
    expect(keys(5)).toEqual(['random:20', 'heur2:40', 'heur4:100', 'prev:60', 'heur6:40']);
    expect(keys(10, true)).toEqual(['heur2:40', 'heur4:100', 'prev:60', 'prev10:40', 'heur6:40']);
    const prev10 = gauntletOpponents(20, { depth: 4, scale: 1, dropRandom: false }).find((o) => o.key === 'prev10')!;
    expect(prev10.spec).toEqual({ kind: 'net', gen: 10, depth: 4 });
  });

  it('scales game counts to even numbers of at least two', () => {
    expect(scaledGames(100, 0.15)).toBe(16);
    expect(scaledGames(20, 0.01)).toBe(2);
    expect(scaledGames(60, 1)).toBe(60);
  });

  it('pairs every opening with colours swapped', () => {
    const pairs = pairedOpenings(10, 4);
    expect(pairs).toHaveLength(10);
    for (let i = 0; i < 10; i += 2) {
      expect(pairs[i].opening).toBe(pairs[i + 1].opening);
      expect([pairs[i].aIsBlack, pairs[i + 1].aIsBlack]).toEqual([true, false]);
    }
    expect(new Set(pairs.map((p) => p.opening)).size).toBe(5);
  });

  it('plays legal match games and scores them from player A’s side', () => {
    const heur = { spec: { kind: 'heuristic' as const, depth: 2 }, searcher: new Searcher(new HeuristicEvaluator(), { ttBits: 14 }) };
    const random = { spec: { kind: 'random' as const }, searcher: null };
    const rng = new Rng(8);
    const games = [0, 1, 2, 3].map((i) => {
      const aIsBlack = i % 2 === 0;
      const g = playMatchGame(aIsBlack ? heur : random, aIsBlack ? random : heur, openings()[i * 40], () => rng.next(), TRAIN_MAX_PLIES);
      expectConsistent(g);
      return { ...g, aScore: scoreFor(g.result, aIsBlack ? 0 : 1) };
    });
    const wdl = tallyWdl(games);
    expect(wdl.w + wdl.d + wdl.l).toBe(4);
    expect(wdl.w).toBeGreaterThanOrEqual(3);
  });

  it('records evals only from the subject and carries them over the opponent’s plies', () => {
    const rng = new Rng(3);
    const net = Network.random([132, 16, 1], () => rng.next(), 1);
    const subject = { spec: { kind: 'net' as const, gen: 1, depth: 2 }, searcher: new Searcher(new NetEvaluator(net), { ttBits: 14 }) };
    const heur = { spec: { kind: 'heuristic' as const, depth: 2 }, searcher: new Searcher(new HeuristicEvaluator(), { ttBits: 14 }) };
    for (const subjectIsBlack of [true, false]) {
      const [black, white] = subjectIsBlack ? [subject, heur] : [heur, subject];
      const opening = openings()[17];
      const g = playMatchGame(black, white, opening, () => rng.next(), 120, subject);
      const replayed = Game.fromMoves(g.moves, { maxPlies: 120 });
      expect(replayed.status().over).toBe(true);
      const subjectSide = subjectIsBlack ? 0 : 1;
      for (let ply = 1; ply < g.evals.length; ply++) {
        const mover = ply % 2;
        if (mover !== subjectSide || ply < opening.length) expect(g.evals[ply], `ply ${ply}`).toBe(g.evals[ply - 1]);
      }
      expect(g.evals.slice(0, opening.length).every((e) => e === 0)).toBe(true);
    }
  });
});

describe('checkGameRecord', () => {
  const base = { id: 'x', kind: 'selfplay' as const, black: 0, white: 0 };

  it('accepts a real finished game', () => {
    const rng = new Rng(2);
    const game = new Game({ maxPlies: TRAIN_MAX_PLIES });
    while (!game.status().over) game.play(rng.pick(game.legalMoves()));
    const status = game.status();
    if (!status.over) throw new Error('unreachable');
    expect(checkGameRecord({ ...base, moves: game.notation(), result: resultString(status.winner), reason: status.reason }, 'g')).toEqual([]);
  });

  it('rejects illegal moves, unfinished games and wrong results', () => {
    expect(checkGameRecord({ ...base, moves: ['11-16', '9-14'], result: '1-0', reason: 'no-moves' }, 'g').join()).toMatch(/Illegal move/);
    expect(checkGameRecord({ ...base, moves: ['11-15'], result: '1-0', reason: 'no-moves' }, 'g').join()).toMatch(/not over/);
    expect(checkGameRecord({ ...base, moves: ['11-15'], result: '1-0', reason: 'no-moves', evals: [500] }, 'g').join()).toMatch(/evals/);
  });
});
