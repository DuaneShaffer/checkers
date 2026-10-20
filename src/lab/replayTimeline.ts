import { applyMove, parseMove } from '../engine/index.ts';
import { has, popcount, squares } from '../engine/bitboard.ts';
import { INITIAL_FEN, fromFen } from '../engine/position.ts';
import type { Move, Position, ResultStr, Side } from '../engine/types.ts';
import type { PieceIds } from '../scene/types.ts';

export const EVAL_LIMIT = 100;

export interface ReplayPly {
  move: Move;
  notation: string;
  side: Side;
  captures: number;
  crowned: boolean;
}

export interface ReplayTimeline {
  startFen: string;
  length: number;
  positions: Position[];
  ids: PieceIds[];
  plies: ReplayPly[];
  evals: number[];
}

export interface TimelineSource {
  startFen?: string;
  moves: readonly string[];
  evals?: readonly number[];
  result?: ResultStr;
}

export class ReplayError extends Error {
  readonly ply: number;
  constructor(ply: number, message: string) {
    super(message);
    this.name = 'ReplayError';
    this.ply = ply;
  }
}

export function initialIds(pos: Position): PieceIds {
  const ids = new Int16Array(32).fill(-1);
  let next = 0;
  for (const sq of squares((pos.black | pos.white) >>> 0)) ids[sq] = next++;
  return ids;
}

export function advanceIds(ids: PieceIds, move: Move): PieceIds {
  const out = ids.slice();
  const moving = out[move.from];
  for (const sq of squares(move.captured)) out[sq] = -1;
  out[move.from] = -1;
  out[move.to] = moving;
  return out;
}

export function buildTimeline(src: TimelineSource): ReplayTimeline {
  const startFen = src.startFen ?? INITIAL_FEN;
  let pos: Position;
  try {
    pos = fromFen(startFen);
  } catch (e) {
    throw new ReplayError(0, `Bad start position: ${(e as Error).message}`);
  }
  let ids = initialIds(pos);
  const positions: Position[] = [pos];
  const idList: PieceIds[] = [ids];
  const plies: ReplayPly[] = [];
  src.moves.forEach((notation, i) => {
    const move = parseMove(pos, notation);
    if (!move) throw new ReplayError(i, `Illegal move ${i + 1} (${notation})`);
    const next = applyMove(pos, move);
    const crowned = !has(pos.kings, move.from) && has(next.kings, move.to);
    plies.push({ move, notation, side: pos.turn, captures: popcount(move.captured), crowned });
    pos = next;
    ids = advanceIds(ids, move);
    positions.push(pos);
    idList.push(ids);
  });
  return {
    startFen,
    length: plies.length,
    positions,
    ids: idList,
    plies,
    evals: normalizeEvals(src.evals, plies.length, src.result),
  };
}

export function clampEval(e: number): number {
  return Math.max(-EVAL_LIMIT, Math.min(EVAL_LIMIT, Math.round(e)));
}

export function evalToWinProbability(e: number): number {
  return (clampEval(e) / EVAL_LIMIT + 1) / 2;
}

function resultEval(result: ResultStr | undefined): number | null {
  if (result === '1-0') return EVAL_LIMIT;
  if (result === '0-1') return -EVAL_LIMIT;
  if (result === '1/2-1/2') return 0;
  return null;
}

/** evals[i] is the score of the position before ply i; the final position takes the game result. */
function normalizeEvals(evals: readonly number[] | undefined, length: number, result: ResultStr | undefined): number[] {
  if (!evals || evals.length === 0) return [];
  const perPosition = evals.length > length ? evals.slice(0, length + 1) : [...evals];
  const out: number[] = [];
  let last = 0;
  for (let i = 0; i <= length; i++) {
    const v = perPosition[i];
    if (v !== undefined && Number.isFinite(v)) last = clampEval(v);
    else if (i === length) last = resultEval(result) ?? last;
    out.push(last);
  }
  return out;
}

export function fullMoveLabel(startTurn: Side, ply: number): { number: number; side: Side } {
  const offset = startTurn === 1 ? 1 : 0;
  const index = ply + offset;
  return { number: Math.floor(index / 2) + 1, side: (index % 2) as Side };
}

export function clampPly(t: ReplayTimeline, ply: number): number {
  if (!Number.isFinite(ply)) return 0;
  return Math.max(0, Math.min(t.length, Math.trunc(ply)));
}
