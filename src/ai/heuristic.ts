import { downLeft, downRight, popcount, upLeft, upRight } from '../engine/bitboard.ts';
import type { Position } from '../engine/types.ts';
import { relativeBoards } from './features.ts';
import { EVAL_RANGE } from './protocol.ts';
import type { Evaluator } from './search.ts';

export const MAN_VALUE = 100;
export const KING_VALUE = 140;
const GUARD_BONUS = 8;
const CENTER_BONUS = 5;
const ADVANCE_BONUS = 1;
const MOBILITY_BONUS = 2;
const TRADE_DOWN_BONUS = 4;
const KING_CHASE_PENALTY = 4;
const ENDGAME_PIECES = 12;

const OWN_GUARD = (1 << 0) | (1 << 2);
const OPP_GUARD = ((1 << 29) | (1 << 31)) >>> 0;
const CENTER = (1 << 13) | (1 << 14) | (1 << 17) | (1 << 18);

const ROW = new Int8Array(32);
const COL = new Int8Array(32);
for (let sq = 0; sq < 32; sq++) {
  ROW[sq] = sq >> 2;
  COL[sq] = ROW[sq] % 2 === 0 ? 2 * (sq & 3) + 1 : 2 * (sq & 3);
}

function rowSum(board: number): number {
  let sum = 0;
  for (let b = board; b !== 0; b = (b & (b - 1)) >>> 0) sum += ROW[31 - Math.clz32(b & -b)];
  return sum;
}

function forwardMoves(men: number, empty: number, down: boolean): number {
  return down
    ? popcount(downLeft(men) & empty) + popcount(downRight(men) & empty)
    : popcount(upLeft(men) & empty) + popcount(upRight(men) & empty);
}

function kingMoves(kings: number, empty: number): number {
  return forwardMoves(kings, empty, true) + forwardMoves(kings, empty, false);
}

function distanceToNearest(sq: number, targets: number): number {
  let best = 8;
  for (let b = targets; b !== 0; b = (b & (b - 1)) >>> 0) {
    const t = 31 - Math.clz32(b & -b);
    const d = Math.max(Math.abs(ROW[sq] - ROW[t]), Math.abs(COL[sq] - COL[t]));
    if (d < best) best = d;
  }
  return best;
}

function chaseDistance(kings: number, targets: number): number {
  let sum = 0;
  for (let b = kings; b !== 0; b = (b & (b - 1)) >>> 0) sum += distanceToNearest(31 - Math.clz32(b & -b), targets);
  return sum;
}

function endgameDrive(strongKings: number, weak: number, total: number): number {
  return TRADE_DOWN_BONUS * (24 - total) - KING_CHASE_PENALTY * chaseDistance(strongKings, weak);
}

export function heuristicScore(p: Position): number {
  const { own, opp, kings } = relativeBoards(p);
  const empty = ~(own | opp) >>> 0;
  const ownKings = (own & kings) >>> 0;
  const oppKings = (opp & kings) >>> 0;
  const ownMen = (own & ~kings) >>> 0;
  const oppMen = (opp & ~kings) >>> 0;
  const nOwnMen = popcount(ownMen);
  const nOppMen = popcount(oppMen);
  const nOwnKings = popcount(ownKings);
  const nOppKings = popcount(oppKings);
  const total = nOwnMen + nOppMen + nOwnKings + nOppKings;

  const ownMaterial = MAN_VALUE * nOwnMen + KING_VALUE * nOwnKings;
  const oppMaterial = MAN_VALUE * nOppMen + KING_VALUE * nOppKings;
  let score = ownMaterial - oppMaterial;
  score += GUARD_BONUS * (popcount(ownMen & OWN_GUARD) - popcount(oppMen & OPP_GUARD));
  score += CENTER_BONUS * (popcount(ownMen & CENTER) - popcount(oppMen & CENTER));
  const ownMobility = forwardMoves(ownMen, empty, true) + kingMoves(ownKings, empty);
  const oppMobility = forwardMoves(oppMen, empty, false) + kingMoves(oppKings, empty);
  score += MOBILITY_BONUS * (ownMobility - oppMobility);
  if (total <= ENDGAME_PIECES) {
    score += ADVANCE_BONUS * (rowSum(ownMen) - (7 * nOppMen - rowSum(oppMen)));
    if (ownMaterial > oppMaterial) score += endgameDrive(ownKings, opp, total);
    else if (oppMaterial > ownMaterial) score -= endgameDrive(oppKings, own, total);
  }
  return Math.max(-EVAL_RANGE, Math.min(EVAL_RANGE, score));
}

export class HeuristicEvaluator implements Evaluator {
  evaluate(p: Position): number {
    return heuristicScore(p);
  }
}
