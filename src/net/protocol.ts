import type { GameResult, Side } from '../engine/types.ts';

export type { GameResult };

export const PROTO = 1;
export const MAX_MESSAGE_BYTES = 64 * 1024;

export type Role = 'host' | 'guest';
export type OfferKind = 'draw' | 'rematch';

export interface OnlineGame {
  id: string;
  hostSide: Side;
  moves: string[];
  result?: GameResult;
}

export interface PendingOffer { kind: OfferKind; gameId: string; ply: number; from: Role }

export type WireMsg =
  | { t: 'hello'; proto: typeof PROTO; clientId: string; role: Role; name?: string }
  | { t: 'reject'; reason: 'room-full' | 'proto-mismatch' }
  | { t: 'sync'; game: OnlineGame | null; offer?: PendingOffer }
  | { t: 'start'; game: { id: string; hostSide: Side } }
  | { t: 'move'; gameId: string; ply: number; move: string; hash: string }
  | { t: 'resign'; gameId: string; ply: number }
  | { t: 'offer'; kind: OfferKind; gameId: string; ply: number }
  | { t: 'answer'; kind: OfferKind; gameId: string; ply: number; accept: boolean }
  | { t: 'ping' | 'pong'; n: number; ply: number; hash: string }
  | { t: 'ice-restart'; sdp: string; kind: 'offer' | 'answer' }
  | { t: 'bye' };

export interface SignalPayload {
  v: 1;
  code: string;
  role: Role;
  sdp: string;
  gameId?: string;
  name?: string;
}

export type ConnStatus = 'idle' | 'creating' | 'waiting-reply' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

export type OnlineError =
  | { kind: 'ice-failed' }
  | { kind: 'timeout' }
  | { kind: 'bad-link' }
  | { kind: 'room-full' }
  | { kind: 'proto-mismatch' }
  | { kind: 'other-tab' }
  | { kind: 'desync' };
