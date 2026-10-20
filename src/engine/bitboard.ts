import type { Sq } from './types.ts';

export const BLACK_START = 0x00000fff;
export const WHITE_START = 0xfff00000;
export const BLACK_PROMO_ROW = 0xf0000000;
export const WHITE_PROMO_ROW = 0x0000000f;

export const downRight = (b: number): number => (((b & 0x07070707) << 5) | ((b & 0x00f0f0f0) << 4)) >>> 0;
export const downLeft = (b: number): number => (((b & 0x0f0f0f0f) << 4) | ((b & 0x00e0e0e0) << 3)) >>> 0;
export const upRight = (b: number): number => (((b & 0x07070700) >>> 3) | ((b & 0xf0f0f0f0) >>> 4)) >>> 0;
export const upLeft = (b: number): number => (((b & 0x0f0f0f00) >>> 4) | ((b & 0xe0e0e0e0) >>> 5)) >>> 0;

export const bit = (sq: Sq): number => (1 << sq) >>> 0;
export const has = (b: number, sq: Sq): boolean => ((b >>> sq) & 1) === 1;
export const lsb = (b: number): Sq => 31 - Math.clz32(b & -b);

export function popcount(b: number): number {
  b = b - ((b >>> 1) & 0x55555555);
  b = (b & 0x33333333) + ((b >>> 2) & 0x33333333);
  return (Math.imul((b + (b >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

export function reverseBits(b: number): number {
  b = ((b >>> 1) & 0x55555555) | ((b & 0x55555555) << 1);
  b = ((b >>> 2) & 0x33333333) | ((b & 0x33333333) << 2);
  b = ((b >>> 4) & 0x0f0f0f0f) | ((b & 0x0f0f0f0f) << 4);
  b = ((b >>> 8) & 0x00ff00ff) | ((b & 0x00ff00ff) << 8);
  return ((b >>> 16) | (b << 16)) >>> 0;
}

export function* squares(b: number): Generator<Sq> {
  while (b !== 0) {
    yield lsb(b);
    b = (b & (b - 1)) >>> 0;
  }
}

export function sqToRowCol(sq: Sq): { row: number; col: number } {
  const row = sq >> 2;
  const col = row % 2 === 0 ? 2 * (sq & 3) + 1 : 2 * (sq & 3);
  return { row, col };
}

export function rowColToSq(row: number, col: number): Sq | null {
  if (row < 0 || row > 7 || col < 0 || col > 7 || (row + col) % 2 === 0) return null;
  return row * 4 + (row % 2 === 0 ? (col - 1) / 2 : col / 2);
}
