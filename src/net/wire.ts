import type { Side } from '../engine/types.ts';
import { MAX_MESSAGE_BYTES, PROTO } from './protocol.ts';
import type { GameResult, OfferKind, OnlineGame, PendingOffer, Role, WireMsg } from './protocol.ts';

export const MAX_NAME_LENGTH = 24;
export const MAX_GAME_PLIES = 2000;
const MAX_SDP_LENGTH = 16_000;
const ID_RE = /^[A-Za-z0-9._-]{1,40}$/;
const MOVE_RE = /^\d{1,2}([-x]\d{1,2}){1,12}$/;
const HASH_RE = /^[0-9a-f]{1,8}$/;
const END_REASONS = new Set(['no-moves', 'repetition', 'no-progress', 'max-plies', 'resign', 'agreement']);

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNat = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isSide = (v: unknown): v is Side => v === 0 || v === 1;
const isRole = (v: unknown): v is Role => v === 'host' || v === 'guest';
const isOfferKind = (v: unknown): v is OfferKind => v === 'draw' || v === 'rematch';
const isPly = (v: unknown): v is number => isNat(v) && v <= MAX_GAME_PLIES;
export const isGameId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);
export const isMoveString = (v: unknown): v is string => typeof v === 'string' && MOVE_RE.test(v);
const isHash = (v: unknown): v is string => typeof v === 'string' && HASH_RE.test(v);

export function cleanName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const name = v.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH).trimEnd();
  return name || undefined;
}

export function isGameResult(v: unknown): v is GameResult {
  return isObj(v) && (v.winner === null || isSide(v.winner)) && typeof v.reason === 'string' && END_REASONS.has(v.reason);
}

export function isOnlineGame(v: unknown): v is OnlineGame {
  return (
    isObj(v) &&
    isGameId(v.id) &&
    isSide(v.hostSide) &&
    Array.isArray(v.moves) &&
    v.moves.length <= MAX_GAME_PLIES &&
    v.moves.every(isMoveString) &&
    (v.result === undefined || isGameResult(v.result))
  );
}

export function isPendingOffer(v: unknown): v is PendingOffer {
  return isObj(v) && isOfferKind(v.kind) && isGameId(v.gameId) && isPly(v.ply) && isRole(v.from);
}

function copyGame(g: OnlineGame): OnlineGame {
  const game: OnlineGame = { id: g.id, hostSide: g.hostSide, moves: [...g.moves] };
  if (g.result) game.result = { winner: g.result.winner, reason: g.result.reason };
  return game;
}

function toWire(m: Obj): WireMsg | null {
  switch (m.t) {
    case 'hello': {
      if (m.proto !== PROTO && !isNat(m.proto)) return null;
      if (typeof m.clientId !== 'string' || !ID_RE.test(m.clientId) || !isRole(m.role)) return null;
      const name = cleanName(m.name);
      return { t: 'hello', proto: m.proto as typeof PROTO, clientId: m.clientId, role: m.role, ...(name ? { name } : {}) };
    }
    case 'reject':
      return m.reason === 'room-full' || m.reason === 'proto-mismatch' ? { t: 'reject', reason: m.reason } : null;
    case 'sync': {
      if (m.game !== null && !isOnlineGame(m.game)) return null;
      if (m.offer !== undefined && !isPendingOffer(m.offer)) return null;
      const msg: WireMsg = { t: 'sync', game: m.game === null ? null : copyGame(m.game) };
      if (m.offer) msg.offer = { ...m.offer };
      return msg;
    }
    case 'start':
      if (!isObj(m.game) || !isGameId(m.game.id) || !isSide(m.game.hostSide)) return null;
      return { t: 'start', game: { id: m.game.id, hostSide: m.game.hostSide } };
    case 'move':
      if (!isGameId(m.gameId) || !isPly(m.ply) || !isMoveString(m.move) || !isHash(m.hash)) return null;
      return { t: 'move', gameId: m.gameId, ply: m.ply, move: m.move, hash: m.hash };
    case 'resign':
      if (!isGameId(m.gameId) || !isPly(m.ply)) return null;
      return { t: 'resign', gameId: m.gameId, ply: m.ply };
    case 'offer':
      if (!isOfferKind(m.kind) || !isGameId(m.gameId) || !isPly(m.ply)) return null;
      return { t: 'offer', kind: m.kind, gameId: m.gameId, ply: m.ply };
    case 'answer':
      if (!isOfferKind(m.kind) || !isGameId(m.gameId) || !isPly(m.ply) || typeof m.accept !== 'boolean') return null;
      return { t: 'answer', kind: m.kind, gameId: m.gameId, ply: m.ply, accept: m.accept };
    case 'ping':
    case 'pong':
      if (!isNat(m.n) || !isPly(m.ply) || !isHash(m.hash)) return null;
      return { t: m.t, n: m.n, ply: m.ply, hash: m.hash };
    case 'ice-restart':
      if (typeof m.sdp !== 'string' || m.sdp.length > MAX_SDP_LENGTH || (m.kind !== 'offer' && m.kind !== 'answer')) return null;
      return { t: 'ice-restart', sdp: m.sdp, kind: m.kind };
    case 'bye':
      return { t: 'bye' };
    default:
      return null;
  }
}

export function decodeWire(raw: unknown): WireMsg | null {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isObj(parsed) ? toWire(parsed) : null;
}

export function encodeWire(msg: WireMsg): string {
  return JSON.stringify(msg);
}
