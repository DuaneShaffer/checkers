import type { LevelSpec } from './levels.ts';

export type NetId = string | 'heuristic';

export type AiRequest =
  | { type: 'loadNet'; netId: string; url: string }
  | { type: 'think'; reqId: number; netId: NetId; startFen: string; moves: string[]; level: LevelSpec; seed?: number };

export type AiResponse =
  | { type: 'netLoaded'; netId: string; gen: number }
  | { type: 'move'; reqId: number; move: string; score: number; depth: number; nodes: number; pv: string[]; ms: number }
  | { type: 'error'; reqId?: number; message: string };

export interface AiMove { move: string; score: number; depth: number; nodes: number; pv: string[]; ms: number }

export const MATE_SCORE = 30000;
export const EVAL_RANGE = 1000;

export function winProbability(score: number): number {
  const s = Math.max(-EVAL_RANGE, Math.min(EVAL_RANGE, score));
  return (s / EVAL_RANGE + 1) / 2;
}

export interface GameRef { startFen: string; moves: readonly string[] }

export interface AiClientApi {
  loadNet(netId: string, url: string): Promise<void>;
  think(game: GameRef, netId: NetId, level: LevelSpec, seed?: number): Promise<AiMove>;
  cancel(): void;
  dispose(): void;
}
