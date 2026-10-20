import { Game, Rng, allOpenings, mixSeed, moveToString, resultString } from '../src/engine/index.ts';
import type { Side } from '../src/engine/index.ts';
import type { Searcher } from '../src/ai/search.ts';
import type { BaselineId, OpponentKey, PlayerId, WDL } from '../src/shared/formats.ts';
import { evalToSide0Hundredths, gameOutcome } from './selfplay.ts';
import type { PlayedGame, RandomSource } from './selfplay.ts';

export type PlayerSpec =
  | { kind: 'random' }
  | { kind: 'heuristic'; depth: number }
  | { kind: 'net'; gen: number; depth: number };

export interface MatchPairing {
  opening: readonly string[];
  aIsBlack: boolean;
}

export interface MatchGame extends PlayedGame {
  aIsBlack: boolean;
  aScore: number;
}

export interface GauntletOpponent {
  key: OpponentKey;
  id: PlayerId;
  spec: PlayerSpec;
  games: number;
}

export interface CalibrationPairing {
  a: BaselineId;
  b: BaselineId;
  games: number;
}

export const BASELINES: Record<BaselineId, { name: string; spec: PlayerSpec }> = {
  random: { name: 'Random mover', spec: { kind: 'random' } },
  heur2: { name: 'Heuristic d2', spec: { kind: 'heuristic', depth: 2 } },
  heur4: { name: 'Heuristic d4', spec: { kind: 'heuristic', depth: 4 } },
  heur6: { name: 'Heuristic d6', spec: { kind: 'heuristic', depth: 6 } },
};

export const GAUNTLET_GAMES: Record<OpponentKey, number> = {
  random: 20,
  heur2: 40,
  heur4: 100,
  heur6: 40,
  prev: 60,
  prev10: 40,
};

export const CALIBRATION: readonly CalibrationPairing[] = [
  { a: 'random', b: 'heur2', games: 20 },
  { a: 'heur2', b: 'heur4', games: 40 },
  { a: 'heur4', b: 'heur6', games: 40 },
];

export const PERIODIC_EVERY = 5;
export const RANDOM_SATURATION_GENS = 3;

export function scaledGames(games: number, scale: number): number {
  return Math.max(2, 2 * Math.round((games * scale) / 2));
}

export interface GauntletPlanOptions {
  depth: number;
  scale: number;
  dropRandom: boolean;
}

export function gauntletOpponents(gen: number, opts: GauntletPlanOptions): GauntletOpponent[] {
  const list: GauntletOpponent[] = [];
  const add = (key: OpponentKey, id: PlayerId, spec: PlayerSpec): void => {
    list.push({ key, id, spec, games: scaledGames(GAUNTLET_GAMES[key], opts.scale) });
  };
  if (!opts.dropRandom) add('random', 'random', BASELINES.random.spec);
  add('heur2', 'heur2', BASELINES.heur2.spec);
  add('heur4', 'heur4', BASELINES.heur4.spec);
  if (gen > 0) add('prev', gen - 1, { kind: 'net', gen: gen - 1, depth: opts.depth });
  if (gen > 0 && gen % PERIODIC_EVERY === 0) {
    if (gen >= 10) add('prev10', gen - 10, { kind: 'net', gen: gen - 10, depth: opts.depth });
    add('heur6', 'heur6', BASELINES.heur6.spec);
  }
  return list;
}

let openingCache: string[][] | null = null;

export function openings(): string[][] {
  return (openingCache ??= allOpenings(3));
}

export function pairedOpenings(games: number, seed: number): MatchPairing[] {
  const pool = new Rng(seed).shuffle(openings().slice());
  const pairs: MatchPairing[] = [];
  for (let k = 0; pairs.length < games; k++) {
    const opening = pool[k % pool.length];
    pairs.push({ opening, aIsBlack: true });
    if (pairs.length < games) pairs.push({ opening, aIsBlack: false });
  }
  return pairs;
}

export function gauntletSeed(runSeed: number, gen: number): number {
  return mixSeed(runSeed, gen, 0x6a7);
}

export interface MatchPlayer {
  spec: PlayerSpec;
  searcher: Searcher | null;
}

/** Evals come only from `subject`'s searches and carry over on the other side's plies, so replays show one evaluator. */
export function playMatchGame(
  black: MatchPlayer,
  white: MatchPlayer,
  opening: readonly string[],
  rng: RandomSource,
  maxPlies: number,
  subject: MatchPlayer = black,
): PlayedGame {
  const game = new Game({ maxPlies });
  const players = [black, white];
  for (const p of players) p.searcher?.clear();
  const evals: number[] = [];
  const random: number[] = [];
  let lastEval = 0;
  while (!game.status().over) {
    const ply = game.ply;
    const pos = game.position;
    const player = players[pos.turn];
    const moves = game.legalMoves();
    if (ply < opening.length) {
      const move = moves.find((m) => moveToString(m) === opening[ply]);
      if (!move) throw new Error(`Opening move ${opening[ply]} at ply ${ply} is illegal`);
      evals.push(lastEval);
      random.push(ply);
      game.play(move);
      continue;
    }
    if (player.spec.kind === 'random' || !player.searcher) {
      evals.push(lastEval);
      game.play(moves[Math.floor(rng() * moves.length)]);
      continue;
    }
    const r = player.searcher.search(pos, {
      maxDepth: player.spec.depth,
      history: game.historyHashes(),
      quietPlies: game.quietPlies,
    });
    if (player === subject) lastEval = evalToSide0Hundredths(r.score, pos.turn);
    evals.push(lastEval);
    game.play(r.move);
  }
  const { winner, reason } = gameOutcome(game);
  return { moves: game.notation(), result: resultString(winner), reason, evals, random, explore: [] };
}

export function scoreFor(result: PlayedGame['result'], side: Side): number {
  if (result === '1/2-1/2') return 0.5;
  return (result === '1-0') === (side === 0) ? 1 : 0;
}

export function tallyWdl(games: readonly { aScore: number }[]): WDL {
  const wdl: WDL = { w: 0, d: 0, l: 0 };
  for (const g of games) {
    if (g.aScore === 1) wdl.w++;
    else if (g.aScore === 0) wdl.l++;
    else wdl.d++;
  }
  return wdl;
}

export function playerKey(id: PlayerId): string {
  return typeof id === 'number' ? `g${id}` : id;
}

export function parsePlayerKey(key: string): PlayerId {
  return /^g\d+$/.test(key) ? Number(key.slice(1)) : (key as PlayerId);
}
