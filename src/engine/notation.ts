import { legalMoves } from './movegen.ts';
import type { Move, Position, Sq } from './types.ts';

export function moveToString(m: Move): string {
  return m.path.map((sq) => sq + 1).join(m.captured !== 0 ? 'x' : '-');
}

const QUIET_RE = /^(\d{1,2})-(\d{1,2})$/;
const CAPTURE_RE = /^\d{1,2}(?:x\d{1,2})+$/;

function parseSquares(text: string): { squares: Sq[]; capture: boolean } | null {
  const s = text.trim().toLowerCase();
  const capture = CAPTURE_RE.test(s);
  if (!capture && !QUIET_RE.test(s)) return null;
  const squares = s.split(capture ? 'x' : '-').map((n) => Number(n) - 1);
  if (squares.some((sq) => sq < 0 || sq > 31)) return null;
  return { squares, capture };
}

function samePath(a: readonly Sq[], b: readonly Sq[]): boolean {
  return a.length === b.length && a.every((sq, i) => sq === b[i]);
}

export function parseMove(p: Position, text: string): Move | null {
  return matchMove(legalMoves(p), text);
}

export function matchMove(moves: readonly Move[], text: string): Move | null {
  const parsed = parseSquares(text);
  if (!parsed) return null;
  const { squares, capture } = parsed;
  const candidates = moves.filter((m) => (m.captured !== 0) === capture);
  const exact = candidates.find((m) => samePath(m.path, squares));
  if (exact) return exact;
  if (!capture || squares.length !== 2) return null;
  const routes = candidates.filter((m) => m.from === squares[0] && m.to === squares[1]);
  if (routes.length === 0) return null;
  return routes.every((m) => m.captured === routes[0].captured) ? routes[0] : null;
}

export function movesWithPrefix(moves: readonly Move[], prefix: readonly Sq[]): Move[] {
  return moves.filter((m) => prefix.length <= m.path.length && prefix.every((sq, i) => m.path[i] === sq));
}
