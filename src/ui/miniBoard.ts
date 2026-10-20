import { has, squares } from '../engine/bitboard.ts';
import type { Position, Side, Sq } from '../engine/types.ts';
import { toScreen } from '../game/keyboard.ts';
import { s } from './dom.ts';

export interface MiniBoardOptions {
  orientation?: Side;
  lastMove?: readonly [Sq, Sq] | null;
  label?: string;
  className?: string;
}

export function miniBoard(pos: Position, opts: MiniBoardOptions = {}): SVGSVGElement {
  const orientation = opts.orientation ?? 0;
  const svg = s('svg', { viewBox: '0 0 8 8', class: opts.className ? `mini-board ${opts.className}` : 'mini-board', role: 'img', 'aria-label': opts.label ?? 'Board position' });
  svg.append(s('rect', { x: 0, y: 0, width: 8, height: 8, class: 'mb-light' }));
  const last = new Set(opts.lastMove ?? []);
  for (let sq = 0; sq < 32; sq++) {
    const { r, c } = toScreen(sq, orientation);
    svg.append(s('rect', { x: c, y: r, width: 1, height: 1, class: last.has(sq) ? 'mb-dark mb-last' : 'mb-dark' }));
  }
  for (const [bits, cls] of [[pos.black, 'mb-crimson'], [pos.white, 'mb-ivory']] as const) {
    for (const sq of squares(bits)) {
      const { r, c } = toScreen(sq, orientation);
      svg.append(s('circle', { cx: c + 0.5, cy: r + 0.5, r: 0.36, class: `mb-piece ${cls}` }));
      if (has(pos.kings, sq)) svg.append(s('circle', { cx: c + 0.5, cy: r + 0.5, r: 0.15, class: 'mb-crown' }));
    }
  }
  return svg;
}
