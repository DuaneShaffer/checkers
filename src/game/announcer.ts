import { popcount } from '../engine/bitboard.ts';
import { sidePieces } from '../engine/position.ts';
import type { Move, Position, Side } from '../engine/types.ts';
import type { GameResult } from '../net/protocol.ts';

export const SIDE_NAMES: Record<Side, string> = { 0: 'Crimson', 1: 'Ivory' };

const pdn = (sq: number) => String(sq + 1);

export function describeMove(move: Move, mover: Side): string {
  const who = SIDE_NAMES[mover];
  const n = popcount(move.captured);
  const text = n > 0
    ? `${who} jumps ${move.path.map(pdn).join(' to ')}, captures ${n}`
    : `${who} ${pdn(move.from)} to ${pdn(move.to)}`;
  return move.promotes ? `${text}, crowned on ${pdn(move.to)}` : text;
}

export function describeReason(result: GameResult, finalPosition: Position): string {
  switch (result.reason) {
    case 'no-moves': {
      const loser = finalPosition.turn;
      return popcount(sidePieces(finalPosition, loser)) === 0
        ? `${SIDE_NAMES[loser]} has no pieces left`
        : `${SIDE_NAMES[loser]} is blocked with no legal moves`;
    }
    case 'repetition':
      return 'Draw by threefold repetition';
    case 'no-progress':
      return 'Draw: 40 moves each without a capture or a man moving';
    case 'max-plies':
      return 'Draw: move limit reached';
    case 'resign':
      return result.winner === null ? 'Resigned' : `${SIDE_NAMES[(1 - result.winner) as Side]} resigned`;
    case 'agreement':
      return 'Draw agreed';
  }
}

export function resultHeadline(result: GameResult, mySides: readonly Side[]): string {
  if (result.winner === null) return 'Draw';
  if (mySides.length === 1) return mySides[0] === result.winner ? 'You win' : 'You lose';
  return `${SIDE_NAMES[result.winner]} wins`;
}

export interface Announcer {
  polite(text: string): void;
  assertive(text: string): void;
}

export function createAnnouncer(politeEl: HTMLElement | null, assertiveEl: HTMLElement | null): Announcer {
  const say = (el: HTMLElement | null, text: string) => {
    if (!el) return;
    el.textContent = '';
    setTimeout(() => (el.textContent = text), 40);
  };
  return {
    polite: (text) => say(politeEl, text),
    assertive: (text) => say(assertiveEl, text),
  };
}
