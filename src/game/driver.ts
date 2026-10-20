import type { Side } from '../engine/types.ts';
import type { ConnStatus, GameResult, OfferKind, OnlineError, Role } from '../net/protocol.ts';

export interface OnlineSnapshot {
  status: ConnStatus;
  role: Role;
  code: string;
  rttMs?: number;
  peerName?: string;
  incomingOffer?: OfferKind;
  outgoingOffer?: OfferKind;
  error?: OnlineError;
}

export interface DriverSnapshot {
  startFen: string;
  moves: string[];
  mySides: Side[];
  result?: GameResult;
  thinking?: boolean;
  online?: OnlineSnapshot;
}

export interface GameDriver {
  subscribe(fn: (s: DriverSnapshot) => void): () => void;
  snapshot(): DriverSnapshot;
  submitMove(move: string): boolean;
  undo?(): void;
  resign(): void;
  offer?(kind: OfferKind): void;
  answer?(kind: OfferKind, accept: boolean): void;
  dispose(): void;
}
