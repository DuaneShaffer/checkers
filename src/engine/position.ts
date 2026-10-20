import { BLACK_START, WHITE_START, bit, has, reverseBits, squares } from './bitboard.ts';
import type { Position, Side, Sq } from './types.ts';

export function initialPosition(): Position {
  return { black: BLACK_START, white: WHITE_START, kings: 0, turn: 0 };
}

export function pieceAt(p: Position, sq: Sq): { side: Side; king: boolean } | null {
  const king = has(p.kings, sq);
  if (has(p.black, sq)) return { side: 0, king };
  if (has(p.white, sq)) return { side: 1, king };
  return null;
}

export function occupied(p: Position): number {
  return (p.black | p.white) >>> 0;
}

export function sidePieces(p: Position, side: Side): number {
  return side === 0 ? p.black : p.white;
}

export function flip(p: Position): Position {
  return {
    black: reverseBits(p.white),
    white: reverseBits(p.black),
    kings: reverseBits(p.kings),
    turn: (1 - p.turn) as Side,
  };
}

export function samePosition(a: Position, b: Position): boolean {
  return a.black === b.black && a.white === b.white && a.kings === b.kings && a.turn === b.turn;
}

function fenSide(b: number, kings: number): string {
  return [...squares(b)].map((sq) => (has(kings, sq) ? 'K' : '') + (sq + 1)).join(',');
}

export function toFen(p: Position): string {
  return `${p.turn === 0 ? 'B' : 'W'}:W${fenSide(p.white, p.kings)}:B${fenSide(p.black, p.kings)}`;
}

export function fromFen(fen: string): Position {
  const parts = fen.trim().replace(/\.$/, '').split(':');
  const turnTok = parts[0]?.toUpperCase();
  if (parts.length !== 3 || (turnTok !== 'B' && turnTok !== 'W')) throw new Error(`Bad FEN: ${fen}`);
  let black = 0, white = 0, kings = 0;
  for (const part of parts.slice(1)) {
    const color = part[0]?.toUpperCase();
    if (color !== 'W' && color !== 'B') throw new Error(`Bad FEN side: ${fen}`);
    for (const tok of part.slice(1).split(',').filter(Boolean)) {
      const king = /^K/i.test(tok);
      const range = tok.replace(/^K/i, '').split('-').map(Number);
      const [lo, hi = lo] = range;
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi > 32 || lo > hi) throw new Error(`Bad FEN square: ${tok}`);
      for (let n = lo; n <= hi; n++) {
        const b = bit(n - 1);
        if (color === 'B') black |= b; else white |= b;
        if (king) kings |= b;
      }
    }
  }
  if ((black & white) !== 0) throw new Error(`Overlapping FEN: ${fen}`);
  return { black: black >>> 0, white: white >>> 0, kings: kings >>> 0, turn: turnTok === 'B' ? 0 : 1 };
}

export const INITIAL_FEN = toFen(initialPosition());
