import { popcount, reverseBits } from '../engine/bitboard.ts';
import { hasCapture } from '../engine/movegen.ts';
import type { Position } from '../engine/types.ts';

export const SPARSE_INPUTS = 128;
export const EXTRA_INPUTS = 4;
export const INPUTS = SPARSE_INPUTS + EXTRA_INPUTS;
export const MAX_ACTIVE = 24;

export const OWN_MEN = 0;
export const OWN_KINGS = 32;
export const OPP_MEN = 64;
export const OPP_KINGS = 96;

export interface RelativeBoards {
  own: number;
  opp: number;
  kings: number;
}

const relative: RelativeBoards = { own: 0, opp: 0, kings: 0 };
const opponentToMove = { black: 0, white: 0, kings: 0, turn: 1 as const };

export function relativeBoards(p: Position, out: RelativeBoards = relative): RelativeBoards {
  if (p.turn === 0) {
    out.own = p.black;
    out.opp = p.white;
    out.kings = p.kings;
  } else {
    out.own = reverseBits(p.white);
    out.opp = reverseBits(p.black);
    out.kings = reverseBits(p.kings);
  }
  return out;
}

function pushSquares(board: number, base: number, active: Int32Array, count: number): number {
  for (let b = board; b !== 0; b = (b & (b - 1)) >>> 0) active[count++] = base + (31 - Math.clz32(b & -b));
  return count;
}

export function encode(p: Position, active: Int32Array, extras: Float32Array): number {
  const { own, opp, kings } = relativeBoards(p);
  const ownKings = (own & kings) >>> 0;
  const oppKings = (opp & kings) >>> 0;
  const ownMen = (own & ~kings) >>> 0;
  const oppMen = (opp & ~kings) >>> 0;

  let count = pushSquares(ownMen, OWN_MEN, active, 0);
  count = pushSquares(ownKings, OWN_KINGS, active, count);
  count = pushSquares(oppMen, OPP_MEN, active, count);
  count = pushSquares(oppKings, OPP_KINGS, active, count);

  const nOwnMen = popcount(ownMen);
  const nOppMen = popcount(oppMen);
  const nOwnKings = popcount(ownKings);
  const nOppKings = popcount(oppKings);
  opponentToMove.black = own;
  opponentToMove.white = opp;
  opponentToMove.kings = kings;
  extras[0] = (nOwnMen - nOppMen) / 12;
  extras[1] = (nOwnKings - nOppKings) / 12;
  extras[2] = (nOwnMen + nOppMen + nOwnKings + nOppKings) / 24;
  extras[3] = hasCapture(opponentToMove, 1) ? 1 : 0;
  return count;
}

const denseActive = new Int32Array(32);
const denseExtras = new Float32Array(EXTRA_INPUTS);

export function encodeDense(p: Position, out: Float32Array = new Float32Array(INPUTS)): Float32Array {
  out.fill(0, 0, SPARSE_INPUTS);
  const count = encode(p, denseActive, denseExtras);
  for (let k = 0; k < count; k++) out[denseActive[k]] = 1;
  out.set(denseExtras, SPARSE_INPUTS);
  return out;
}
