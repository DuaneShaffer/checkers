import type { Move, Position, Side, Sq } from '../engine/types.ts';

export type PieceIds = Int16Array;

export interface Highlights {
  movable?: Sq[];
  targets?: Sq[];
  captureTargets?: Sq[];
  pending?: Sq[];
  lastMove?: readonly [Sq, Sq] | null;
  cursor?: Sq | null;
  selected?: Sq | null;
}

export interface BoardView {
  setPosition(pos: Position, ids?: PieceIds): void;
  sync(pos: Position, ids: PieceIds, opts?: { duration?: number }): Promise<void>;
  playMove(move: Move, opts?: { speed?: number; fromHop?: number }): Promise<void>;
  previewHop(from: Sq, to: Sq, captured: Sq | null): Promise<void>;
  cancelPreview(): void;
  setHighlights(h: Highlights): void;
  setOrientation(side: Side, animate: boolean): Promise<void>;
  squareAtClient(x: number, y: number): Sq | null;
  clientOfSquare(sq: Sq): { x: number; y: number };
  onSquareTap(fn: (sq: Sq | null) => void): () => void;
  setBoardSlot(el: HTMLElement | null): void;
  setVisible(visible: boolean): void;
  setInstantAnimations(instant: boolean): void;
  dispose(): void;
}

export interface BoardViewOptions {
  testMode?: boolean;
}

export type CreateBoardView = (host: HTMLElement, opts?: BoardViewOptions) => Promise<BoardView>;
