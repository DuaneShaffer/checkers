import type { GameController } from '../game/controller.ts';
import type { BoardView } from '../scene/types.ts';
import type { GameScreenOptions } from './contracts.ts';
import type { RouteName } from './router.ts';

export interface ActiveGame {
  controller: GameController;
  mode: GameScreenOptions['mode'];
}

export interface AppState {
  route: RouteName;
  board: BoardView | null;
  activeGame: ActiveGame | null;
}

export const appState: AppState = { route: 'home', board: null, activeGame: null };

