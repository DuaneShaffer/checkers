import { Rng } from './rng.ts';
import type { Position, Side, Sq } from './types.ts';

export const ZOBRIST_SEED = 0xc0ffee;

function randomKeys(rng: Rng, n: number): Uint32Array {
  const keys = new Uint32Array(n);
  for (let i = 0; i < n; i++) keys[i] = rng.nextU32();
  return keys;
}

const rng = new Rng(ZOBRIST_SEED);
export const KEYS_HI = randomKeys(rng, 128);
export const KEYS_LO = randomKeys(rng, 128);
export const SIDE_HI = rng.nextU32();
export const SIDE_LO = rng.nextU32();

export function pieceKeyIndex(side: Side, king: boolean, sq: Sq): number {
  return (side + (king ? 2 : 0)) * 32 + sq;
}

function xorPieces(keys: Uint32Array, p: Position): number {
  let h = 0;
  const kinds = [p.black & ~p.kings, p.white & ~p.kings, p.black & p.kings, p.white & p.kings];
  for (let kind = 0; kind < 4; kind++) {
    let b = kinds[kind] >>> 0;
    while (b !== 0) {
      const sq = 31 - Math.clz32(b & -b);
      h ^= keys[kind * 32 + sq];
      b = (b & (b - 1)) >>> 0;
    }
  }
  return h;
}

export function hashHi(p: Position): number {
  return (xorPieces(KEYS_HI, p) ^ (p.turn === 1 ? SIDE_HI : 0)) >>> 0;
}

export function hashLo(p: Position): number {
  return (xorPieces(KEYS_LO, p) ^ (p.turn === 1 ? SIDE_LO : 0)) >>> 0;
}

export function hashOf(p: Position): [hi: number, lo: number] {
  return [hashHi(p), hashLo(p)];
}
