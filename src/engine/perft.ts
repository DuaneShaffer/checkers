import { MoveList, genMoves, makeInto, newSearchPosition, toSearchPosition } from './movegen.ts';
import { moveToString } from './notation.ts';
import type { Position } from './types.ts';

const MAX_DEPTH = 64;
const lists = Array.from({ length: MAX_DEPTH }, () => new MoveList(64));
const stack = Array.from({ length: MAX_DEPTH + 1 }, newSearchPosition);

function perftFrom(ply: number, depth: number): number {
  const list = lists[ply];
  const n = genMoves(stack[ply], list);
  if (depth === 1) return n;
  let nodes = 0;
  for (let i = 0; i < n; i++) {
    makeInto(stack[ply + 1], stack[ply], list, i);
    nodes += perftFrom(ply + 1, depth - 1);
  }
  return nodes;
}

function checkDepth(depth: number): void {
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_DEPTH) throw new Error(`perft depth must be 0..${MAX_DEPTH}`);
}

export function perft(p: Position, depth: number): number {
  checkDepth(depth);
  if (depth === 0) return 1;
  toSearchPosition(p, 0, stack[0]);
  return perftFrom(0, depth);
}

export interface DivideEntry {
  move: string;
  nodes: number;
}

export function divide(p: Position, depth: number): DivideEntry[] {
  checkDepth(depth);
  if (depth === 0) return [];
  toSearchPosition(p, 0, stack[0]);
  const root = new MoveList(64);
  const n = genMoves(stack[0], root);
  const entries: DivideEntry[] = [];
  for (let i = 0; i < n; i++) {
    makeInto(stack[1], stack[0], root, i);
    entries.push({ move: moveToString(root.move(i)), nodes: depth === 1 ? 1 : perftFrom(1, depth - 1) });
  }
  return entries;
}
