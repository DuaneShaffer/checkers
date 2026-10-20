export type Side = 0 | 1;
export type Sq = number;

export interface Position {
  readonly black: number;
  readonly white: number;
  readonly kings: number;
  readonly turn: Side;
}

export interface Move {
  readonly from: Sq;
  readonly to: Sq;
  readonly path: readonly Sq[];
  readonly captured: number;
  readonly promotes: boolean;
}

export type EndReason = 'no-moves' | 'repetition' | 'no-progress' | 'max-plies' | 'resign' | 'agreement';
export interface GameResult { winner: Side | null; reason: EndReason }
export type GameStatus = { over: false } | { over: true; winner: Side | null; reason: EndReason };
export type ResultStr = '1-0' | '0-1' | '1/2-1/2';

export const BLACK: Side = 0;
export const WHITE: Side = 1;
export const NO_PROGRESS_PLIES = 80;
export const TRAIN_MAX_PLIES = 300;
