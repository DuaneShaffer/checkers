import { has, sqToRowCol } from '../engine/bitboard.ts';
import type { Position, Side, Sq } from '../engine/types.ts';
import { s } from './dom.ts';

export function screenCell(sq: Sq, orientation: Side): { x: number; y: number } {
  const { row, col } = sqToRowCol(sq);
  return orientation === 0 ? { x: 7 - col, y: 7 - row } : { x: col, y: row };
}

export interface MiniBoardOptions {
  orientation?: Side;
  lastMove?: readonly [Sq, Sq] | null;
  label?: string;
}

export function miniBoard(pos: Position, opts: MiniBoardOptions = {}): SVGSVGElement {
  const orientation = opts.orientation ?? 0;
  const svg = s('svg', {
    viewBox: '0 0 8 8',
    class: 'lab-mini',
    role: opts.label ? 'img' : null,
    'aria-label': opts.label ?? null,
    'aria-hidden': opts.label ? null : 'true',
  });
  svg.append(s('rect', { x: 0, y: 0, width: 8, height: 8, class: 'lab-mb-light' }));
  const lastSquares = new Set(opts.lastMove ?? []);
  for (let sq = 0; sq < 32; sq++) {
    const { x, y } = screenCell(sq, orientation);
    svg.append(s('rect', { x, y, width: 1, height: 1, class: lastSquares.has(sq) ? 'lab-mb-dark lab-mb-last' : 'lab-mb-dark' }));
    const side: Side | null = has(pos.black, sq) ? 0 : has(pos.white, sq) ? 1 : null;
    if (side === null) continue;
    const cls = side === 0 ? 'lab-mb-piece lab-mb-crimson' : 'lab-mb-piece lab-mb-ivory';
    svg.append(s('circle', { cx: x + 0.5, cy: y + 0.5, r: 0.38, class: cls }));
    if (has(pos.kings, sq)) svg.append(s('circle', { cx: x + 0.5, cy: y + 0.5, r: 0.17, class: 'lab-mb-crown' }));
  }
  return svg;
}
