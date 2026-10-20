import { BLACK_PROMO_ROW, WHITE_PROMO_ROW, bit, downLeft, downRight, lsb, upLeft, upRight } from './bitboard.ts';
import type { Move, Position, Side, Sq } from './types.ts';
import { KEYS_HI, KEYS_LO, SIDE_HI, SIDE_LO, hashHi, hashLo } from './zobrist.ts';

export const FLAG_PROMOTES = 1;
export const FLAG_CAPTURE = 2;
export const FLAG_MAN = 4;

const DIRECTION_SHIFTS = [downLeft, downRight, upLeft, upRight];
const NEXT = new Int8Array(4 * 32).fill(-1);
for (let dir = 0; dir < 4; dir++) {
  for (let sq = 0; sq < 32; sq++) {
    const b = DIRECTION_SHIFTS[dir](bit(sq));
    if (b !== 0) NEXT[dir * 32 + sq] = lsb(b);
  }
}

const MAN_FIRST_DIR: readonly number[] = [0, 2];
const PROMO_ROW: readonly number[] = [BLACK_PROMO_ROW, WHITE_PROMO_ROW];

export class MoveList {
  count = 0;
  pathUsed = 0;
  from: Uint8Array;
  to: Uint8Array;
  captured: Uint32Array;
  flags: Uint8Array;
  pathStart: Uint32Array;
  pathLen: Uint8Array;
  paths: Uint8Array;

  constructor(capacity = 64) {
    this.from = new Uint8Array(capacity);
    this.to = new Uint8Array(capacity);
    this.captured = new Uint32Array(capacity);
    this.flags = new Uint8Array(capacity);
    this.pathStart = new Uint32Array(capacity);
    this.pathLen = new Uint8Array(capacity);
    this.paths = new Uint8Array(capacity * 4);
  }

  clear(): void {
    this.count = 0;
    this.pathUsed = 0;
  }

  push(path: Uint8Array, len: number, captured: number, flags: number): void {
    if (this.count === this.from.length) this.growMoves();
    if (this.pathUsed + len > this.paths.length) this.growPaths(len);
    const i = this.count++;
    const start = this.pathUsed;
    this.from[i] = path[0];
    this.to[i] = path[len - 1];
    this.captured[i] = captured;
    this.flags[i] = flags;
    this.pathStart[i] = start;
    this.pathLen[i] = len;
    for (let k = 0; k < len; k++) this.paths[start + k] = path[k];
    this.pathUsed = start + len;
  }

  pushQuiet(from: Sq, to: Sq, flags: number): void {
    if (this.count === this.from.length) this.growMoves();
    if (this.pathUsed + 2 > this.paths.length) this.growPaths(2);
    const i = this.count++;
    const start = this.pathUsed;
    this.from[i] = from;
    this.to[i] = to;
    this.captured[i] = 0;
    this.flags[i] = flags;
    this.pathStart[i] = start;
    this.pathLen[i] = 2;
    this.paths[start] = from;
    this.paths[start + 1] = to;
    this.pathUsed = start + 2;
  }

  path(i: number): Sq[] {
    const start = this.pathStart[i];
    return Array.from(this.paths.subarray(start, start + this.pathLen[i]));
  }

  move(i: number): Move {
    return {
      from: this.from[i],
      to: this.to[i],
      path: this.path(i),
      captured: this.captured[i],
      promotes: (this.flags[i] & FLAG_PROMOTES) !== 0,
    };
  }

  isCapture(i: number): boolean {
    return (this.flags[i] & FLAG_CAPTURE) !== 0;
  }

  isIrreversible(i: number): boolean {
    return (this.flags[i] & (FLAG_CAPTURE | FLAG_MAN)) !== 0;
  }

  private growMoves(): void {
    const capacity = this.from.length * 2;
    this.from = grow(this.from, new Uint8Array(capacity));
    this.to = grow(this.to, new Uint8Array(capacity));
    this.captured = grow(this.captured, new Uint32Array(capacity));
    this.flags = grow(this.flags, new Uint8Array(capacity));
    this.pathStart = grow(this.pathStart, new Uint32Array(capacity));
    this.pathLen = grow(this.pathLen, new Uint8Array(capacity));
  }

  private growPaths(extra: number): void {
    this.paths = grow(this.paths, new Uint8Array((this.paths.length + extra) * 2));
  }
}

function grow<T extends Uint8Array | Uint32Array>(old: T, next: T): T {
  next.set(old);
  return next;
}

function captureTargets(own: number, opp: number, kings: number, side: Side): number {
  const empty = ~(own | opp);
  const ownKings = own & kings;
  const forwardLeft = side === 0 ? downLeft : upLeft;
  const forwardRight = side === 0 ? downRight : upRight;
  const backLeft = side === 0 ? upLeft : downLeft;
  const backRight = side === 0 ? upRight : downRight;
  return (
    (forwardLeft(forwardLeft(own) & opp) |
      forwardRight(forwardRight(own) & opp) |
      backLeft(backLeft(ownKings) & opp) |
      backRight(backRight(ownKings) & opp)) &
    empty
  );
}

export function hasCapture(p: Position, side: Side): boolean {
  const own = side === 0 ? p.black : p.white;
  const opp = side === 0 ? p.white : p.black;
  return captureTargets(own, opp, p.kings, side) !== 0;
}

const jumpPath = new Uint8Array(32);
let jumpList: MoveList = new MoveList();
let jumpOpp = 0;
let jumpOcc = 0;
let jumpFirstDir = 0;
let jumpLastDir = 0;
let jumpPromoRow = 0;
let jumpFlags = 0;

function continueJumps(sq: Sq, depth: number, captured: number): boolean {
  let found = false;
  for (let dir = jumpFirstDir; dir <= jumpLastDir; dir++) {
    const mid = NEXT[dir * 32 + sq];
    if (mid < 0 || ((jumpOpp >>> mid) & 1) === 0 || ((captured >>> mid) & 1) === 1) continue;
    const land = NEXT[dir * 32 + mid];
    if (land < 0 || ((jumpOcc >>> land) & 1) === 1) continue;
    found = true;
    jumpPath[depth] = land;
    const nowCaptured = (captured | (1 << mid)) >>> 0;
    if (((jumpPromoRow >>> land) & 1) === 1) {
      jumpList.push(jumpPath, depth + 1, nowCaptured, jumpFlags | FLAG_PROMOTES);
    } else if (!continueJumps(land, depth + 1, nowCaptured)) {
      jumpList.push(jumpPath, depth + 1, nowCaptured, jumpFlags);
    }
  }
  return found;
}

function genCaptures(own: number, opp: number, kings: number, side: Side, list: MoveList): void {
  jumpList = list;
  jumpOpp = opp;
  for (let movers = own; movers !== 0; movers = (movers & (movers - 1)) >>> 0) {
    const from = lsb(movers);
    const king = ((kings >>> from) & 1) === 1;
    jumpOcc = ((own | opp) & ~(1 << from)) >>> 0;
    jumpFirstDir = king ? 0 : MAN_FIRST_DIR[side];
    jumpLastDir = king ? 3 : jumpFirstDir + 1;
    jumpPromoRow = king ? 0 : PROMO_ROW[side];
    jumpFlags = FLAG_CAPTURE | (king ? 0 : FLAG_MAN);
    jumpPath[0] = from;
    continueJumps(from, 1, 0);
  }
}

function genQuiet(own: number, opp: number, kings: number, side: Side, list: MoveList): void {
  const occ = own | opp;
  for (let movers = own; movers !== 0; movers = (movers & (movers - 1)) >>> 0) {
    const from = lsb(movers);
    const king = ((kings >>> from) & 1) === 1;
    const firstDir = king ? 0 : MAN_FIRST_DIR[side];
    const lastDir = king ? 3 : firstDir + 1;
    const promoRow = king ? 0 : PROMO_ROW[side];
    const manFlag = king ? 0 : FLAG_MAN;
    for (let dir = firstDir; dir <= lastDir; dir++) {
      const to = NEXT[dir * 32 + from];
      if (to < 0 || ((occ >>> to) & 1) === 1) continue;
      list.pushQuiet(from, to, manFlag | (((promoRow >>> to) & 1) === 1 ? FLAG_PROMOTES : 0));
    }
  }
}

export function genMoves(p: Position, list: MoveList): number {
  list.clear();
  const side = p.turn;
  const own = side === 0 ? p.black : p.white;
  const opp = side === 0 ? p.white : p.black;
  if (captureTargets(own, opp, p.kings, side) !== 0) genCaptures(own, opp, p.kings, side, list);
  else genQuiet(own, opp, p.kings, side, list);
  return list.count;
}

export interface SearchPosition {
  black: number;
  white: number;
  kings: number;
  turn: Side;
  hi: number;
  lo: number;
  quiet: number;
}

export function newSearchPosition(): SearchPosition {
  return { black: 0, white: 0, kings: 0, turn: 0, hi: 0, lo: 0, quiet: 0 };
}

export function toSearchPosition(p: Position, quiet = 0, dst: SearchPosition = newSearchPosition()): SearchPosition {
  dst.black = p.black;
  dst.white = p.white;
  dst.kings = p.kings;
  dst.turn = p.turn;
  dst.hi = hashHi(p);
  dst.lo = hashLo(p);
  dst.quiet = quiet;
  return dst;
}

export function copySearchPosition(dst: SearchPosition, src: SearchPosition): SearchPosition {
  dst.black = src.black;
  dst.white = src.white;
  dst.kings = src.kings;
  dst.turn = src.turn;
  dst.hi = src.hi;
  dst.lo = src.lo;
  dst.quiet = src.quiet;
  return dst;
}

export function makeInto(dst: SearchPosition, src: SearchPosition, list: MoveList, i: number): void {
  const from = list.from[i];
  const to = list.to[i];
  const captured = list.captured[i];
  const flags = list.flags[i];
  const side = src.turn;
  const opp = 1 - side;
  const fromBit = 1 << from;
  const toBit = 1 << to;
  const wasKing = (src.kings >>> from) & 1;
  const fromKey = (side + 2 * wasKing) * 32 + from;
  const toKey = (side + 2 * (wasKing | (flags & FLAG_PROMOTES))) * 32 + to;
  let hi = src.hi ^ SIDE_HI ^ KEYS_HI[fromKey] ^ KEYS_HI[toKey];
  let lo = src.lo ^ SIDE_LO ^ KEYS_LO[fromKey] ^ KEYS_LO[toKey];
  for (let b = captured; b !== 0; b = (b & (b - 1)) >>> 0) {
    const sq = lsb(b);
    const key = (opp + 2 * ((src.kings >>> sq) & 1)) * 32 + sq;
    hi ^= KEYS_HI[key];
    lo ^= KEYS_LO[key];
  }
  let kings = src.kings;
  if (wasKing === 1) kings = (kings & ~fromBit) | toBit;
  else if ((flags & FLAG_PROMOTES) !== 0) kings |= toBit;
  if (side === 0) {
    dst.black = ((src.black & ~fromBit) | toBit) >>> 0;
    dst.white = (src.white & ~captured) >>> 0;
  } else {
    dst.white = ((src.white & ~fromBit) | toBit) >>> 0;
    dst.black = (src.black & ~captured) >>> 0;
  }
  dst.kings = (kings & ~captured) >>> 0;
  dst.turn = opp as Side;
  dst.hi = hi >>> 0;
  dst.lo = lo >>> 0;
  dst.quiet = (flags & (FLAG_CAPTURE | FLAG_MAN)) !== 0 ? 0 : src.quiet + 1;
}

const scratch = new MoveList(128);

export function legalMoves(p: Position): Move[] {
  const n = genMoves(p, scratch);
  const moves: Move[] = new Array(n);
  for (let i = 0; i < n; i++) moves[i] = scratch.move(i);
  return moves;
}

export function applyMove(p: Position, m: Move): Position {
  const fromBit = bit(m.from);
  const toBit = bit(m.to);
  const wasKing = ((p.kings >>> m.from) & 1) === 1;
  const promotes = !wasKing && ((PROMO_ROW[p.turn] >>> m.to) & 1) === 1;
  let kings = p.kings;
  if (wasKing) kings = (kings & ~fromBit) | toBit;
  else if (promotes) kings |= toBit;
  kings &= ~m.captured;
  const moveOwn = (b: number): number => ((b & ~fromBit) | toBit) >>> 0;
  const removeCaptured = (b: number): number => (b & ~m.captured) >>> 0;
  return {
    black: p.turn === 0 ? moveOwn(p.black) : removeCaptured(p.black),
    white: p.turn === 1 ? moveOwn(p.white) : removeCaptured(p.white),
    kings: kings >>> 0,
    turn: (1 - p.turn) as Side,
  };
}

export function isIrreversible(p: Position, m: Move): boolean {
  return m.captured !== 0 || ((p.kings >>> m.from) & 1) === 0;
}

export function jumpedSquare(a: Sq, b: Sq): Sq {
  for (let dir = 0; dir < 4; dir++) {
    const mid = NEXT[dir * 32 + a];
    if (mid >= 0 && NEXT[dir * 32 + mid] === b) return mid;
  }
  throw new Error(`Squares ${a + 1} and ${b + 1} are not a jump apart`);
}

export function capturedSquares(m: Move): Sq[] {
  if (m.captured === 0) return [];
  const squares: Sq[] = [];
  for (let k = 0; k + 1 < m.path.length; k++) squares.push(jumpedSquare(m.path[k], m.path[k + 1]));
  return squares;
}
