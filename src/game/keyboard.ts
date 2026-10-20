import { rowColToSq, sqToRowCol } from '../engine/bitboard.ts';
import type { Side, Sq } from '../engine/types.ts';

export type Direction = 'up' | 'down' | 'left' | 'right';

export type KeyAction =
  | { kind: 'cursor'; dir: Direction }
  | { kind: 'activate' }
  | { kind: 'cancel' }
  | { kind: 'undo' }
  | { kind: 'flip' }
  | { kind: 'mute' };

export interface ScreenCell {
  r: number;
  c: number;
}

// Orientation side is nearest the viewer; that side's single corner (sq 3 or sq 28) sits at the near-left.
export function toScreen(sq: Sq, orientation: Side): ScreenCell {
  const { row, col } = sqToRowCol(sq);
  return orientation === 0 ? { r: 7 - row, c: 7 - col } : { r: row, c: col };
}

export function fromScreen(cell: ScreenCell, orientation: Side): Sq | null {
  const row = orientation === 0 ? 7 - cell.r : cell.r;
  const col = orientation === 0 ? 7 - cell.c : cell.c;
  return rowColToSq(row, col);
}

export function stepCursor(cursor: Sq, dir: Direction, orientation: Side): Sq {
  const { r, c } = toScreen(cursor, orientation);
  const zig = c % 2 === 0 ? 1 : -1;
  const next: ScreenCell =
    dir === 'up' ? { r: r - 1, c: c + zig }
    : dir === 'down' ? { r: r + 1, c: c + zig }
    : dir === 'left' ? { r, c: c - 2 }
    : { r, c: c + 2 };
  return fromScreen(next, orientation) ?? cursor;
}

export function startCursor(preferred: readonly Sq[], orientation: Side): Sq {
  if (preferred.length === 0) return fromScreen({ r: 4, c: 3 }, orientation) ?? 0;
  let best = preferred[0];
  let bestScore = Infinity;
  for (const sq of preferred) {
    const { r, c } = toScreen(sq, orientation);
    const score = (7 - r) * 16 + Math.abs(c - 3.5);
    if (score < bestScore) {
      best = sq;
      bestScore = score;
    }
  }
  return best;
}

const ARROWS: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

export function keyAction(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): KeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const dir = ARROWS[e.key];
  if (dir) return { kind: 'cursor', dir };
  switch (e.key) {
    case 'Enter':
    case ' ':
      return { kind: 'activate' };
    case 'Escape':
      return { kind: 'cancel' };
    case 'u':
    case 'U':
      return { kind: 'undo' };
    case 'f':
    case 'F':
      return { kind: 'flip' };
    case 'm':
    case 'M':
      return { kind: 'mute' };
    default:
      return null;
  }
}
