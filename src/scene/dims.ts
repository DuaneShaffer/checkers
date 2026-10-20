import { rowColToSq, sqToRowCol } from '../engine/bitboard.ts';
import type { Side, Sq } from '../engine/types.ts';

export const FIELD_HALF = 4;
export const RAIL = 0.62;
export const FRAME_HALF = FIELD_HALF + RAIL;
export const FRAME_TOP = 0.06;
export const FRAME_BOTTOM = -0.42;

export const PIECE_RADIUS = 0.39;
export const PIECE_HEIGHT = 0.15;
export const KING_HEIGHT = PIECE_HEIGHT * 2;
export const LIFT_HEIGHT = 0.16;

export const TRAY_GAP = 0.14;
export const TRAY_WIDTH = 1.02;
export const TRAY_LENGTH = FRAME_HALF * 2;
export const TRAY_CENTER = FRAME_HALF + TRAY_GAP + TRAY_WIDTH / 2;
export const TRAY_FLOOR = -0.12;
export const TRAY_TOP = 0.02;
export const TRAY_PIECE_SCALE = 0.88;
export const TRAY_SPACING = 0.735;
export const TRAY_CAPACITY = 12;

export type TrayLayout = 'ends' | 'sides';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export function squareCenter(sq: Sq): { x: number; z: number } {
  const { row, col } = sqToRowCol(sq);
  return { x: col - 3.5, z: row - 3.5 };
}

export function squareAtWorld(x: number, z: number): Sq | null {
  const col = Math.floor(x + FIELD_HALF);
  const row = Math.floor(z + FIELD_HALF);
  return rowColToSq(row, col);
}

export function isDarkCell(row: number, col: number): boolean {
  return (row + col) % 2 === 1;
}

/** World pose of a captured piece: `owner` is the side whose tray holds it (the capturer). */
export function traySlot(owner: Side, slot: number, layout: TrayLayout): Vec3Like {
  const along = (slot - (TRAY_CAPACITY - 1) / 2) * TRAY_SPACING;
  if (layout === 'ends') {
    const z = owner === 0 ? -TRAY_CENTER : TRAY_CENTER;
    const x = owner === 0 ? -along : along;
    return { x, y: TRAY_FLOOR, z };
  }
  const x = owner === 0 ? -TRAY_CENTER : TRAY_CENTER;
  const z = owner === 0 ? along : -along;
  return { x, y: TRAY_FLOOR, z };
}

export function framingPoints(layout: TrayLayout): Vec3Like[] {
  const pts: Vec3Like[] = [];
  const corners = (hx: number, hz: number, ys: number[]) => {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of ys) pts.push({ x: sx * hx, y, z: sz * hz });
  };
  corners(FRAME_HALF, FRAME_HALF, [FRAME_TOP, FRAME_BOTTOM]);
  corners(FIELD_HALF - 0.5, FIELD_HALF - 0.5, [KING_HEIGHT]);
  const trayOuter = FRAME_HALF + TRAY_GAP + TRAY_WIDTH;
  if (layout === 'ends') corners(FRAME_HALF, trayOuter, [TRAY_TOP, FRAME_BOTTOM]);
  else corners(trayOuter, FRAME_HALF, [TRAY_TOP, FRAME_BOTTOM]);
  return pts;
}
