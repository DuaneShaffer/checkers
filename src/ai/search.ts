import {
  MoveList,
  genMoves,
  hasCapture,
  makeInto,
  newSearchPosition,
  toSearchPosition,
  type SearchPosition,
} from '../engine/movegen.ts';
import { popcount } from '../engine/bitboard.ts';
import type { Move, Position, Side } from '../engine/types.ts';
import { NO_PROGRESS_PLIES } from '../engine/types.ts';
import { HeuristicEvaluator } from './heuristic.ts';
import type { LevelSpec } from './levels.ts';
import { NetEvaluator, Network } from './network.ts';
import { EVAL_RANGE, MATE_SCORE } from './protocol.ts';

export interface Evaluator {
  evaluate(p: Position): number;
}

export interface SearchOptions {
  maxDepth: number;
  timeMs?: number;
  nodeLimit?: number;
  history?: Uint32Array;
  quietPlies?: number;
  threatExtension?: boolean;
  rootScores?: boolean;
}

export interface RootScore {
  move: Move;
  score: number;
}

export interface SearchResult {
  move: Move;
  score: number;
  depth: number;
  nodes: number;
  pv: Move[];
  leaf: Position | null;
  leafTerminal: boolean;
  rootScores?: RootScore[];
  ms: number;
}

export interface SearcherOptions {
  ttBits?: number;
}

export const MATE = MATE_SCORE;
export const MAX_PLY = 128;
export const DEFAULT_TT_BITS = 20;
const INF = MATE + 1;
const MATE_BOUND = MATE - 1000;
const SINGLE_REPLY_MAX_PLY = 64;
const MAX_THREAT_EXTENSIONS = 2;
const QUIESCENCE_PLY_CAP = 40;
const CHECK_EVERY = 1023;
const NEXT_ITERATION_BUDGET = 0.6;

const FLAG_EXACT = 1;
const FLAG_LOWER = 2;
const FLAG_UPPER = 3;

const SCORE_TT = 1 << 30;
const SCORE_CAPTURE = 1 << 24;
const SCORE_KILLER_1 = 1 << 22;
const SCORE_KILLER_2 = 1 << 21;
const HISTORY_CAP = 1 << 20;

export function isMateScore(score: number): boolean {
  return Math.abs(score) >= MATE_BOUND;
}

function quietKey(list: MoveList, i: number): number {
  return (list.from[i] | (list.to[i] << 5)) + 1;
}

function now(): number {
  return performance.now();
}

class SearchAborted extends Error {}

export class Searcher {
  private ev: Evaluator;
  private readonly ttMask: number;
  private readonly ttLock: Uint32Array;
  private readonly ttScore: Int16Array;
  private readonly ttDepth: Int8Array;
  private readonly ttFlag: Uint8Array;
  private readonly ttMove: Uint8Array;
  private readonly ttAge: Uint8Array;
  private readonly useTt: boolean;
  private age = 0;

  private readonly stack: SearchPosition[] = Array.from({ length: MAX_PLY + 1 }, newSearchPosition);
  private readonly lists: MoveList[] = Array.from({ length: MAX_PLY }, () => new MoveList(64));
  private readonly scores: Int32Array[] = Array.from({ length: MAX_PLY }, () => new Int32Array(64));
  private readonly killers = new Uint16Array(MAX_PLY * 2);
  private readonly historyTable = new Int32Array(2 * 32 * 32);

  private readonly pvIdx = new Uint8Array(MAX_PLY * MAX_PLY);
  private readonly pvLen = new Uint8Array(MAX_PLY + 1);
  private readonly leafBlack = new Uint32Array(MAX_PLY + 1);
  private readonly leafWhite = new Uint32Array(MAX_PLY + 1);
  private readonly leafKings = new Uint32Array(MAX_PLY + 1);
  private readonly leafTurn = new Uint8Array(MAX_PLY + 1);
  private readonly leafTerminal = new Uint8Array(MAX_PLY + 1);

  private repHi = new Uint32Array(MAX_PLY + 256);
  private repLo = new Uint32Array(MAX_PLY + 256);
  private repBase = 0;

  private nodes = 0;
  private deadline = Infinity;
  private nodeLimit = Infinity;
  private threatExtension = false;
  private abortable = false;

  constructor(ev: Evaluator, opts: SearcherOptions = {}) {
    this.ev = ev;
    const bits = opts.ttBits ?? DEFAULT_TT_BITS;
    this.useTt = bits > 0;
    const size = this.useTt ? 1 << Math.min(Math.max(bits, 4), 26) : 1;
    this.ttMask = size - 1;
    this.ttLock = new Uint32Array(size);
    this.ttScore = new Int16Array(size);
    this.ttDepth = new Int8Array(size);
    this.ttFlag = new Uint8Array(size);
    this.ttMove = new Uint8Array(size);
    this.ttAge = new Uint8Array(size);
  }

  get evaluator(): Evaluator {
    return this.ev;
  }

  setEvaluator(ev: Evaluator): void {
    if (ev === this.ev) return;
    this.ev = ev;
    this.clear();
  }

  clear(): void {
    this.ttFlag.fill(0);
    this.killers.fill(0);
    this.historyTable.fill(0);
    this.age = 0;
  }

  search(p: Position, o: SearchOptions): SearchResult {
    const started = now();
    const maxDepth = Math.max(1, Math.min(Math.floor(o.maxDepth), MAX_PLY - QUIESCENCE_PLY_CAP - 8));
    this.nodes = 0;
    this.deadline = o.timeMs !== undefined ? started + o.timeMs : Infinity;
    this.nodeLimit = o.nodeLimit ?? Infinity;
    this.threatExtension = o.threatExtension ?? false;
    this.abortable = false;
    this.age = (this.age + 1) & 0xff;
    for (let i = 0; i < this.historyTable.length; i++) this.historyTable[i] >>= 2;
    this.killers.fill(0);

    const root = this.stack[0];
    toSearchPosition(p, 0, root);
    this.prepareRepetitions(root, o);

    const rootList = new MoveList(64);
    const n = genMoves(root, rootList);
    if (n === 0) throw new Error('search: no legal moves in root position');

    const order = Array.from({ length: n }, (_, i) => i);
    const rootScore = new Int32Array(n);
    let best: SearchResult | null = null;

    for (let depth = 1; depth <= maxDepth; depth++) {
      this.abortable = depth > 1;
      let iteration: { bestIdx: number; score: number };
      try {
        iteration = o.rootScores
          ? this.searchRootExact(rootList, order, rootScore, depth)
          : this.searchRootPvs(rootList, order, rootScore, depth);
      } catch (e) {
        if (e instanceof SearchAborted) break;
        throw e;
      }
      best = this.collect(rootList, iteration.bestIdx, iteration.score, depth, o.rootScores ? rootScore : null, started);
      if (o.rootScores) order.sort((a, b) => rootScore[b] - rootScore[a]);
      else moveToFront(order, iteration.bestIdx);
      if (isMateScore(iteration.score) && MATE - Math.abs(iteration.score) <= depth) break;
      if (this.outOfBudget() || this.nextIterationWouldOverrun(started)) break;
    }
    if (!best) throw new Error('search: first iteration did not complete');
    best.nodes = this.nodes;
    best.ms = now() - started;
    return best;
  }

  private prepareRepetitions(root: SearchPosition, o: SearchOptions): void {
    const history = o.history;
    const pairs = history ? history.length >> 1 : 0;
    const needed = pairs + MAX_PLY + 1;
    if (this.repHi.length < needed) {
      this.repHi = new Uint32Array(needed);
      this.repLo = new Uint32Array(needed);
    }
    let base = 0;
    if (history && pairs > 0) {
      for (let k = 0; k < pairs; k++) {
        this.repHi[k] = history[2 * k];
        this.repLo[k] = history[2 * k + 1];
      }
      const last = pairs - 1;
      base = this.repHi[last] === root.hi && this.repLo[last] === root.lo ? last : pairs;
    }
    this.repBase = base;
    this.repHi[base] = root.hi;
    this.repLo[base] = root.lo;
    root.quiet = o.quietPlies ?? base;
  }

  private searchRootPvs(list: MoveList, order: number[], rootScore: Int32Array, depth: number): { bestIdx: number; score: number } {
    const n = list.count;
    const childDepth = n === 1 ? depth : depth - 1;
    let alpha = -INF;
    let bestIdx = order[0];
    for (let k = 0; k < n; k++) {
      const i = order[k];
      this.makeChild(0, list, i);
      let score: number;
      if (k === 0) {
        score = -this.negamax(1, childDepth, -INF, INF, 0);
      } else {
        score = -this.negamax(1, childDepth, -alpha - 1, -alpha, 0);
        if (score > alpha) score = -this.negamax(1, childDepth, -INF, -alpha, 0);
      }
      rootScore[i] = score;
      if (score > alpha) {
        alpha = score;
        bestIdx = i;
        this.updatePv(0, i);
      }
    }
    return { bestIdx, score: alpha };
  }

  private searchRootExact(list: MoveList, order: number[], rootScore: Int32Array, depth: number): { bestIdx: number; score: number } {
    const n = list.count;
    const childDepth = n === 1 ? depth : depth - 1;
    let best = -INF;
    let bestIdx = order[0];
    for (let k = 0; k < n; k++) {
      const i = order[k];
      this.makeChild(0, list, i);
      const score = -this.negamax(1, childDepth, -INF, INF, 0);
      rootScore[i] = score;
      if (score > best) {
        best = score;
        bestIdx = i;
        this.updatePv(0, i);
      }
    }
    return { bestIdx, score: best };
  }

  private collect(
    list: MoveList,
    bestIdx: number,
    score: number,
    depth: number,
    rootScore: Int32Array | null,
    started: number,
  ): SearchResult {
    const pv = this.reconstructPv();
    const result: SearchResult = {
      move: list.move(bestIdx),
      score: score + 0,
      depth,
      nodes: this.nodes,
      pv: pv.length > 0 ? pv : [list.move(bestIdx)],
      leaf: this.pvLen[0] > 0
        ? { black: this.leafBlack[0], white: this.leafWhite[0], kings: this.leafKings[0], turn: this.leafTurn[0] as Side }
        : null,
      leafTerminal: this.pvLen[0] > 0 && this.leafTerminal[0] === 1,
      ms: now() - started,
    };
    if (rootScore) {
      result.rootScores = Array.from({ length: list.count }, (_, i) => ({ move: list.move(i), score: rootScore[i] }));
    }
    return result;
  }

  private reconstructPv(): Move[] {
    const pv: Move[] = [];
    const scratch = new MoveList(64);
    const pos = newSearchPosition();
    const next = newSearchPosition();
    Object.assign(pos, this.stack[0]);
    for (let k = 0; k < this.pvLen[0]; k++) {
      const n = genMoves(pos, scratch);
      const idx = this.pvIdx[k];
      if (idx >= n) break;
      pv.push(scratch.move(idx));
      makeInto(next, pos, scratch, idx);
      Object.assign(pos, next);
    }
    return pv;
  }

  private nextIterationWouldOverrun(started: number): boolean {
    if (this.deadline === Infinity) return false;
    const t = now();
    return t - started > NEXT_ITERATION_BUDGET * (this.deadline - started);
  }

  private outOfBudget(): boolean {
    return this.nodes >= this.nodeLimit || now() >= this.deadline;
  }

  private checkAbort(): void {
    if ((this.nodes & CHECK_EVERY) === 0 && this.abortable && this.outOfBudget()) throw new SearchAborted();
  }

  private makeChild(ply: number, list: MoveList, i: number): void {
    const child = this.stack[ply + 1];
    makeInto(child, this.stack[ply], list, i);
    const at = this.repBase + ply + 1;
    this.repHi[at] = child.hi;
    this.repLo[at] = child.lo;
  }

  private isRepetition(ply: number, quiet: number): boolean {
    const at = this.repBase + ply;
    const hi = this.repHi[at];
    const lo = this.repLo[at];
    for (let back = 4; back <= quiet && back <= at; back += 2) {
      if (this.repHi[at - back] === hi && this.repLo[at - back] === lo) return true;
    }
    return false;
  }

  private setLeaf(ply: number, terminal: boolean): void {
    const pos = this.stack[ply];
    this.leafBlack[ply] = pos.black;
    this.leafWhite[ply] = pos.white;
    this.leafKings[ply] = pos.kings;
    this.leafTurn[ply] = pos.turn;
    this.leafTerminal[ply] = terminal ? 1 : 0;
  }

  private updatePv(ply: number, moveIdx: number): void {
    const row = ply * MAX_PLY;
    const childRow = row + MAX_PLY;
    const childLen = this.pvLen[ply + 1];
    this.pvIdx[row] = moveIdx;
    for (let k = 0; k < childLen; k++) this.pvIdx[row + 1 + k] = this.pvIdx[childRow + k];
    this.pvLen[ply] = childLen + 1;
    this.leafBlack[ply] = this.leafBlack[ply + 1];
    this.leafWhite[ply] = this.leafWhite[ply + 1];
    this.leafKings[ply] = this.leafKings[ply + 1];
    this.leafTurn[ply] = this.leafTurn[ply + 1];
    this.leafTerminal[ply] = this.leafTerminal[ply + 1];
  }

  private evaluate(ply: number): number {
    this.setLeaf(ply, false);
    const v = this.ev.evaluate(this.stack[ply]);
    return v > EVAL_RANGE ? EVAL_RANGE : v < -EVAL_RANGE ? -EVAL_RANGE : v;
  }

  private terminal(ply: number, score: number): number {
    this.setLeaf(ply, true);
    return score;
  }

  private negamax(ply: number, depth: number, alpha: number, beta: number, threats: number): number {
    this.nodes++;
    this.checkAbort();
    this.pvLen[ply] = 0;
    const pos = this.stack[ply];

    if (this.isRepetition(ply, pos.quiet)) return this.terminal(ply, 0);
    const list = this.lists[ply];
    const n = genMoves(pos, list);
    if (n === 0) return this.terminal(ply, -(MATE - ply));
    if (pos.quiet >= NO_PROGRESS_PLIES) return this.terminal(ply, 0);
    if (ply >= MAX_PLY - 1) return this.evaluate(ply);

    const captures = list.isCapture(0);
    if (depth <= 0) {
      if (!captures) {
        const opp = (1 - pos.turn) as Side;
        if (!this.threatExtension || threats >= MAX_THREAT_EXTENSIONS || !hasCapture(pos, opp)) return this.evaluate(ply);
        depth = 1;
        threats++;
      } else if (depth < -QUIESCENCE_PLY_CAP) {
        return this.evaluate(ply);
      }
    }

    const isPv = beta - alpha > 1;
    const useTt = this.useTt && depth > 0;
    const slot = pos.hi & this.ttMask;
    let ttIdx = -1;
    if (useTt && this.ttFlag[slot] !== 0 && this.ttLock[slot] === pos.lo) {
      ttIdx = this.ttMove[slot] - 1;
      // Exact-depth cutoffs keep fixed-depth scores identical with or without the TT despite extensions.
      if (!isPv && this.ttDepth[slot] === depth) {
        const s = fromTtScore(this.ttScore[slot], ply);
        const flag = this.ttFlag[slot];
        if (flag === FLAG_EXACT || (flag === FLAG_LOWER && s >= beta) || (flag === FLAG_UPPER && s <= alpha)) return s;
      }
    }

    const childDepth = n === 1 && ply < SINGLE_REPLY_MAX_PLY ? depth : depth - 1;
    const scores = this.orderMoves(ply, list, n, ttIdx, captures);
    const alphaOrig = alpha;
    let best = -INF;
    let bestIdx = 0;

    for (let k = 0; k < n; k++) {
      const i = pickNext(scores, k, n);
      this.makeChild(ply, list, i);
      let score: number;
      if (k === 0) {
        score = -this.negamax(ply + 1, childDepth, -beta, -alpha, threats);
      } else {
        score = -this.negamax(ply + 1, childDepth, -alpha - 1, -alpha, threats);
        if (score > alpha && score < beta) score = -this.negamax(ply + 1, childDepth, -beta, -alpha, threats);
      }
      if (score > best) {
        best = score;
        bestIdx = i;
        if (score > alpha) {
          alpha = score;
          this.updatePv(ply, i);
          if (alpha >= beta) {
            if (!captures) this.rewardQuiet(ply, list, i, depth, pos.turn);
            break;
          }
        }
      }
    }

    if (useTt) {
      const flag = best <= alphaOrig ? FLAG_UPPER : best >= beta ? FLAG_LOWER : FLAG_EXACT;
      this.store(slot, pos.lo, depth, flag, toTtScore(best, ply), bestIdx);
    }
    return best;
  }

  private orderMoves(ply: number, list: MoveList, n: number, ttIdx: number, captures: boolean): Int32Array {
    let scores = this.scores[ply];
    if (scores.length < n * 2) scores = this.scores[ply] = new Int32Array(n * 4);
    const k1 = this.killers[ply * 2];
    const k2 = this.killers[ply * 2 + 1];
    const side = this.stack[ply].turn;
    for (let i = 0; i < n; i++) {
      let s: number;
      if (i === ttIdx) s = SCORE_TT;
      else if (captures) s = SCORE_CAPTURE + popcount(list.captured[i]) * 64 + (list.flags[i] & 1) * 32;
      else {
        const key = quietKey(list, i);
        s = key === k1 ? SCORE_KILLER_1 : key === k2 ? SCORE_KILLER_2 : this.historyTable[(side << 10) | (list.from[i] << 5) | list.to[i]];
        if ((list.flags[i] & 1) !== 0) s += HISTORY_CAP;
      }
      scores[i] = s;
      scores[n + i] = i;
    }
    return scores;
  }

  private rewardQuiet(ply: number, list: MoveList, i: number, depth: number, side: Side): void {
    const key = quietKey(list, i);
    const at = ply * 2;
    if (this.killers[at] !== key) {
      this.killers[at + 1] = this.killers[at];
      this.killers[at] = key;
    }
    const h = (side << 10) | (list.from[i] << 5) | list.to[i];
    this.historyTable[h] = Math.min(HISTORY_CAP - 1, this.historyTable[h] + depth * depth);
  }

  private store(slot: number, lock: number, depth: number, flag: number, score: number, moveIdx: number): void {
    const replace = this.ttFlag[slot] === 0 || this.ttAge[slot] !== this.age || depth >= this.ttDepth[slot] || this.ttLock[slot] === lock;
    if (!replace) return;
    this.ttLock[slot] = lock;
    this.ttScore[slot] = score;
    this.ttDepth[slot] = Math.min(depth, 127);
    this.ttFlag[slot] = flag;
    this.ttMove[slot] = moveIdx < 255 ? moveIdx + 1 : 0;
    this.ttAge[slot] = this.age;
  }
}

function toTtScore(score: number, ply: number): number {
  if (score >= MATE_BOUND) return score + ply;
  if (score <= -MATE_BOUND) return score - ply;
  return score;
}

function fromTtScore(score: number, ply: number): number {
  if (score >= MATE_BOUND) return score - ply;
  if (score <= -MATE_BOUND) return score + ply;
  return score;
}

function pickNext(scores: Int32Array, k: number, n: number): number {
  let bestAt = k;
  let bestScore = scores[k];
  for (let j = k + 1; j < n; j++) {
    if (scores[j] > bestScore) {
      bestScore = scores[j];
      bestAt = j;
    }
  }
  if (bestAt !== k) {
    scores[bestAt] = scores[k];
    scores[k] = bestScore;
    const idx = scores[n + bestAt];
    scores[n + bestAt] = scores[n + k];
    scores[n + k] = idx;
  }
  return scores[n + k];
}

function moveToFront(order: number[], idx: number): void {
  const at = order.indexOf(idx);
  if (at > 0) {
    order.splice(at, 1);
    order.unshift(idx);
  }
}

export function pickMove(r: SearchResult, level: Pick<LevelSpec, 'temperature' | 'blunderRate'>, rng: () => number): Move {
  const candidates = r.rootScores;
  if (!candidates || candidates.length < 2) return r.move;
  if (level.blunderRate > 0 && rng() < level.blunderRate) return candidates[Math.floor(rng() * candidates.length)].move;
  if (level.temperature <= 0) return r.move;
  const scale = EVAL_RANGE * level.temperature;
  const top = Math.max(...candidates.map((c) => c.score));
  const weights = candidates.map((c) => Math.exp((c.score - top) / scale));
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rng() * total;
  for (let i = 0; i < candidates.length; i++) {
    x -= weights[i];
    if (x < 0) return candidates[i].move;
  }
  return r.move;
}

export type EvaluatorSource = Network | 'heuristic';

export function createEvaluator(source: EvaluatorSource): Evaluator {
  return source === 'heuristic' ? new HeuristicEvaluator() : new NetEvaluator(source);
}

export function createSearcher(source: EvaluatorSource | Evaluator, opts?: SearcherOptions): Searcher {
  const ev = source === 'heuristic' || source instanceof Network ? createEvaluator(source) : source;
  return new Searcher(ev, opts);
}
