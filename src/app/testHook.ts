import { INITIAL_FEN, fromFen } from '../engine/position.ts';
import type { GameStatus, Side, Sq } from '../engine/types.ts';
import type { ConnStatus } from '../net/protocol.ts';
import { appState } from './store.ts';

export interface TestState {
  fen: string;
  moves: string[];
  turn: Side;
  status: GameStatus;
  mode: string;
  online?: ConnStatus;
  idle: boolean;
}

export interface CheckersTestHook {
  ready: Promise<void>;
  state(): TestState;
  clientOfSquare(sq: Sq): { x: number; y: number };
  playMove(s: string): boolean;
}

declare global {
  interface Window {
    __checkers?: CheckersTestHook;
  }
}

export function testState(): TestState {
  const active = appState.activeGame;
  if (!active) {
    return { fen: INITIAL_FEN, moves: [], turn: fromFen(INITIAL_FEN).turn, status: { over: false }, mode: appState.route, idle: true };
  }
  const c = active.controller;
  const snap = c.snapshot;
  return {
    fen: c.fen(),
    moves: [...snap.moves],
    turn: c.game.position.turn,
    status: c.status(),
    mode: appState.route === 'review' ? 'review' : active.mode,
    online: snap.online?.status,
    idle: c.idle && !snap.thinking,
  };
}

export function installTestHook(currentRoute: () => Promise<void>): void {
  window.__checkers = {
    get ready() {
      return currentRoute();
    },
    state: testState,
    clientOfSquare(sq) {
      const board = appState.board;
      if (!board) throw new Error('Board not ready');
      return board.clientOfSquare(sq);
    },
    playMove(s) {
      return appState.activeGame?.controller.driver.submitMove(s) ?? false;
    },
  };
  document.documentElement.dataset.test = '1';
}
