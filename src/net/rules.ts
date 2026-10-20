import { Game, moveToString, toFen } from '../engine/index.ts';
import type { Side } from '../engine/types.ts';
import type { GameResult, OnlineGame } from './protocol.ts';

export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const hashHex = (text: string): string => fnv1a32(text).toString(16);

const games = new WeakMap<readonly string[], Game>();

function replay(moves: readonly string[]): Game | null {
  const cached = games.get(moves);
  if (cached && cached.ply === moves.length) return cached;
  try {
    const game = Game.fromMoves(moves);
    games.set(moves, game);
    return game;
  } catch {
    return null;
  }
}

export function isLegalLine(moves: readonly string[]): boolean {
  const game = replay(moves);
  return game !== null && game.notation().every((m, i) => m === moves[i]);
}

export function canonicalLine(moves: readonly string[]): string[] | null {
  const game = replay(moves);
  return game ? game.notation() : null;
}

export function sideToMove(moves: readonly string[]): Side {
  return replay(moves)?.position.turn ?? ((moves.length % 2) as Side);
}

export function positionHash(moves: readonly string[]): string {
  const game = replay(moves);
  return game ? hashHex(toFen(game.position)) : '0';
}

export function engineResult(moves: readonly string[]): GameResult | undefined {
  const status = replay(moves)?.status();
  return status?.over ? { winner: status.winner, reason: status.reason } : undefined;
}

export interface AppliedMove {
  moves: string[];
  move: string;
  hash: string;
  result?: GameResult;
}

export function applyMoveText(moves: readonly string[], text: string): AppliedMove | null {
  const game = replay(moves);
  if (!game || game.status().over) return null;
  let canonical: string;
  try {
    canonical = moveToString(game.play(text));
  } catch {
    return null;
  }
  games.delete(moves);
  const next = [...moves, canonical];
  games.set(next, game);
  const status = game.status();
  return {
    moves: next,
    move: canonical,
    hash: hashHex(toFen(game.position)),
    ...(status.over ? { result: { winner: status.winner, reason: status.reason } } : {}),
  };
}

export function stateDigest(game: OnlineGame | null): string {
  if (!game) return hashHex('none');
  const result = game.result ? `${game.result.winner ?? 'd'}:${game.result.reason}` : '';
  return hashHex(`${game.id}|${game.hostSide}|${game.moves.join(' ')}|${result}`);
}
