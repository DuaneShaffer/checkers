import { jumpedSquareOrNull } from '../engine/movegen.ts';
import { movesWithPrefix } from '../engine/notation.ts';
import { pieceAt } from '../engine/position.ts';
import type { Move, Position, Sq } from '../engine/types.ts';

export interface SelectionState {
  readonly position: Position;
  readonly moves: readonly Move[];
  readonly prefix: readonly Sq[];
}

export interface Hop {
  readonly from: Sq;
  readonly to: Sq;
  readonly captured: Sq | null;
}

export type IllegalReason = 'capture-required' | 'blocked' | 'not-a-target';

export type SelectionEffect =
  | { kind: 'none' }
  | { kind: 'select'; from: Sq }
  | { kind: 'deselect'; revertHops: number }
  | { kind: 'advance'; hops: Hop[] }
  | { kind: 'commit'; move: Move; previewedHops: number }
  | { kind: 'illegal'; reason: IllegalReason };

export interface SelectionView {
  movable: Sq[];
  selected: Sq | null;
  current: Sq | null;
  targets: Sq[];
  captureTargets: Sq[];
  pending: Sq[];
  captureRequired: boolean;
}

export interface TapResult {
  state: SelectionState;
  effect: SelectionEffect;
}

export function createSelection(position: Position, moves: readonly Move[]): SelectionState {
  return { position, moves, prefix: [] };
}

export function isCaptureState(s: SelectionState): boolean {
  return s.moves.length > 0 && s.moves[0].captured !== 0;
}

export function movableSquares(s: SelectionState): Sq[] {
  return distinct(s.moves.map((m) => m.from));
}

function candidates(s: SelectionState, prefix: readonly Sq[] = s.prefix): Move[] {
  return movesWithPrefix(s.moves as Move[], prefix);
}

function nextLandings(cands: readonly Move[], depth: number): Sq[] {
  return distinct(cands.filter((m) => m.path.length > depth).map((m) => m.path[depth]));
}

function distinct(xs: readonly Sq[]): Sq[] {
  return [...new Set(xs)];
}

function hop(from: Sq, to: Sq): Hop {
  return { from, to, captured: jumpedSquareOrNull(from, to) };
}

export function selectionView(s: SelectionState): SelectionView {
  const capture = isCaptureState(s);
  const movable = s.prefix.length <= 1 ? movableSquares(s) : [];
  if (s.prefix.length === 0) {
    return { movable, selected: null, current: null, targets: [], captureTargets: [], pending: [], captureRequired: capture };
  }
  const next = nextLandings(candidates(s), s.prefix.length);
  const pending: Sq[] = [];
  for (let i = 1; i < s.prefix.length; i++) {
    const j = jumpedSquareOrNull(s.prefix[i - 1], s.prefix[i]);
    if (j !== null) pending.push(j);
  }
  return {
    movable,
    selected: s.prefix[0],
    current: s.prefix[s.prefix.length - 1],
    targets: capture ? [] : next,
    captureTargets: capture ? next : [],
    pending,
    captureRequired: capture,
  };
}

export function cancelSelection(s: SelectionState): TapResult {
  if (s.prefix.length === 0) return { state: s, effect: { kind: 'none' } };
  return { state: { ...s, prefix: [] }, effect: { kind: 'deselect', revertHops: s.prefix.length - 1 } };
}

export function tapSquare(s: SelectionState, sq: Sq | null): TapResult {
  return s.prefix.length === 0 ? tapIdle(s, sq) : tapSelected(s, sq);
}

function tapIdle(s: SelectionState, sq: Sq | null): TapResult {
  if (sq === null) return { state: s, effect: { kind: 'none' } };
  if (movableSquares(s).includes(sq)) return { state: { ...s, prefix: [sq] }, effect: { kind: 'select', from: sq } };
  if (pieceAt(s.position, sq)?.side === s.position.turn) {
    return { state: s, effect: { kind: 'illegal', reason: isCaptureState(s) ? 'capture-required' : 'blocked' } };
  }
  return { state: s, effect: { kind: 'none' } };
}

function tapSelected(s: SelectionState, sq: Sq | null): TapResult {
  if (sq === null) return { state: s, effect: { kind: 'none' } };
  const current = s.prefix[s.prefix.length - 1];
  if (nextLandings(candidates(s), s.prefix.length).includes(sq)) return extend(s, sq);
  if (sq === current) return cancelSelection(s);
  if (s.prefix.length === 1 && movableSquares(s).includes(sq)) {
    return { state: { ...s, prefix: [sq] }, effect: { kind: 'select', from: sq } };
  }
  if (s.prefix.length === 1 && pieceAt(s.position, sq)?.side === s.position.turn) {
    return { state: s, effect: { kind: 'illegal', reason: isCaptureState(s) ? 'capture-required' : 'blocked' } };
  }
  return { state: s, effect: { kind: 'illegal', reason: 'not-a-target' } };
}

function extend(s: SelectionState, landing: Sq): TapResult {
  const previewedHops = s.prefix.length - 1;
  const prefix = [...s.prefix, landing];
  const hops: Hop[] = [hop(s.prefix[s.prefix.length - 1], landing)];
  for (;;) {
    const cands = candidates(s, prefix);
    const complete = cands.filter((m) => m.path.length === prefix.length);
    if (complete.length > 0 && complete.length === cands.length) {
      return { state: { ...s, prefix: [] }, effect: { kind: 'commit', move: complete[0], previewedHops } };
    }
    const next = nextLandings(cands, prefix.length);
    if (next.length !== 1) break;
    hops.push(hop(prefix[prefix.length - 1], next[0]));
    prefix.push(next[0]);
  }
  return { state: { ...s, prefix }, effect: { kind: 'advance', hops } };
}
