import { Game, legalMoves, moveToString, resultString } from '../src/engine/index.ts';
import type { EndReason, Move, Position, ResultStr, Side } from '../src/engine/index.ts';
import type { Network } from '../src/ai/network.ts';
import { isMateScore, pickMove } from '../src/ai/search.ts';
import type { SearchResult, Searcher } from '../src/ai/search.ts';
import { EVAL_RANGE } from '../src/ai/protocol.ts';

export interface SelfPlayOptions {
  depth: number;
  epsilon: number;
  softmaxPlies: number;
  temperature: number;
  extraRandomPlies: number;
  extraRandomProb: number;
  maxPlies: number;
  lambda: number;
}

export const DEFAULT_SELFPLAY: SelfPlayOptions = {
  depth: 4,
  epsilon: 0.03,
  softmaxPlies: 4,
  temperature: 0.03,
  extraRandomPlies: 3,
  extraRandomProb: 0.3,
  maxPlies: 300,
  lambda: 0.7,
};

export interface PlayedGame {
  moves: string[];
  result: ResultStr;
  reason: EndReason;
  evals: number[];
  random: number[];
  explore: number[];
}

export interface SelfPlayGame extends PlayedGame {
  leaves: Position[];
  targets: number[];
  nodes: number;
}

export type RandomSource = () => number;

export function lambdaTargets(values: readonly number[], explored: readonly boolean[], z: number, lambda: number): number[] {
  const targets = new Array<number>(values.length);
  let next = z;
  for (let t = values.length - 1; t >= 0; t--) {
    const g = explored[t] ? values[t] : next;
    targets[t] = g;
    next = (1 - lambda) * values[t] + lambda * g;
  }
  return targets;
}

export function evalToSide0Hundredths(score: number, turn: Side): number {
  const clamped = isMateScore(score) ? Math.sign(score) * EVAL_RANGE : Math.max(-EVAL_RANGE, Math.min(EVAL_RANGE, score));
  const e = Math.round((clamped * 100) / EVAL_RANGE);
  return (turn === 0 ? e : -e) + 0;
}

export function sameMove(a: Move, b: Move): boolean {
  return a.path.length === b.path.length && a.path.every((sq, i) => sq === b.path[i]);
}

export function blackValueOfLeaf(net: Network, r: SearchResult, root: Position): { value: number; terminal: boolean; leaf: Position } {
  const leaf = r.leaf ?? root;
  if (r.leaf && r.leafTerminal) {
    const lost = legalMoves(leaf).length === 0;
    const stmValue = lost ? -1 : 0;
    return { value: leaf.turn === 0 ? stmValue : -stmValue, terminal: true, leaf };
  }
  const v = net.value(leaf);
  return { value: leaf.turn === 0 ? v : -v, terminal: false, leaf };
}

export function gameOutcome(game: Game): { winner: Side | null; reason: EndReason } {
  const status = game.status();
  if (!status.over) throw new Error('gameOutcome: game is not over');
  return { winner: status.winner, reason: status.reason };
}

function pickOther(moves: readonly Move[], best: Move, rng: RandomSource): Move {
  const others = moves.filter((m) => !sameMove(m, best));
  return others[Math.floor(rng() * others.length)];
}

export function playSelfPlayGame(
  net: Network,
  searcher: Searcher,
  opening: readonly string[],
  rng: RandomSource,
  opts: SelfPlayOptions,
): SelfPlayGame {
  const game = new Game({ maxPlies: opts.maxPlies });
  searcher.clear();
  const values: number[] = [];
  const explored: boolean[] = [];
  const leaves: (Position | null)[] = [];
  const evals: number[] = [];
  const random: number[] = [];
  const explore: number[] = [];
  const firstSearchedPly = opening.length + opts.extraRandomPlies;
  let nodes = 0;

  while (!game.status().over) {
    const ply = game.ply;
    const pos = game.position;
    const softmax = ply >= firstSearchedPly && ply < firstSearchedPly + opts.softmaxPlies;
    const r = searcher.search(pos, {
      maxDepth: opts.depth,
      history: game.historyHashes(),
      quietPlies: game.quietPlies,
      rootScores: softmax,
    });
    nodes += r.nodes;
    const { value, terminal, leaf } = blackValueOfLeaf(net, r, pos);
    evals.push(evalToSide0Hundredths(r.score, pos.turn));
    values.push(value);
    leaves.push(terminal ? null : leaf);

    let move = r.move;
    let isExplored = false;
    if (ply < opening.length) {
      move = game.legalMoves().find((m) => moveToString(m) === opening[ply]) ?? failOpening(opening, ply);
      random.push(ply);
      isExplored = true;
    } else if (ply < firstSearchedPly) {
      if (rng() < opts.extraRandomProb) {
        const moves = game.legalMoves();
        move = moves[Math.floor(rng() * moves.length)];
        random.push(ply);
        isExplored = true;
      }
    } else if (softmax) {
      move = pickMove(r, { temperature: opts.temperature, blunderRate: 0 }, rng);
      isExplored = !sameMove(move, r.move);
    } else if (opts.epsilon > 0 && rng() < opts.epsilon) {
      const moves = game.legalMoves();
      if (moves.length >= 2) {
        move = pickOther(moves, r.move, rng);
        isExplored = true;
      }
    }
    if (isExplored && !random.includes(ply)) explore.push(ply);
    explored.push(isExplored);
    game.play(move);
  }

  const { winner, reason } = gameOutcome(game);
  const z = reason === 'max-plies' ? values[values.length - 1] : winner === null ? 0 : winner === 0 ? 1 : -1;
  const g = lambdaTargets(values, explored, z, opts.lambda);
  const sampleLeaves: Position[] = [];
  const targets: number[] = [];
  for (let t = 0; t < g.length; t++) {
    const leaf = leaves[t];
    if (explored[t] || !leaf) continue;
    sampleLeaves.push(leaf);
    targets.push(leaf.turn === 0 ? g[t] : -g[t]);
  }
  return {
    moves: game.notation(),
    result: resultString(winner),
    reason,
    evals,
    random,
    explore,
    leaves: sampleLeaves,
    targets,
    nodes,
  };
}

function failOpening(opening: readonly string[], ply: number): never {
  throw new Error(`Opening move ${opening[ply]} at ply ${ply} is illegal`);
}

export interface PackedSamples {
  boards: Uint32Array;
  targets: Float32Array;
}

export function packSamples(games: readonly { leaves: Position[]; targets: number[] }[]): PackedSamples {
  const total = games.reduce((n, g) => n + g.targets.length, 0);
  const boards = new Uint32Array(total * 4);
  const targets = new Float32Array(total);
  let k = 0;
  for (const g of games) {
    for (let i = 0; i < g.targets.length; i++, k++) {
      const p = g.leaves[i];
      boards[4 * k] = p.black;
      boards[4 * k + 1] = p.white;
      boards[4 * k + 2] = p.kings;
      boards[4 * k + 3] = p.turn;
      targets[k] = g.targets[i];
    }
  }
  return { boards, targets };
}

export function concatSamples(parts: readonly PackedSamples[]): PackedSamples {
  const total = parts.reduce((n, p) => n + p.targets.length, 0);
  const boards = new Uint32Array(total * 4);
  const targets = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    boards.set(p.boards, at * 4);
    targets.set(p.targets, at);
    at += p.targets.length;
  }
  return { boards, targets };
}
