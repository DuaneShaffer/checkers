import type { Side } from '../engine/types.ts';
import type { GameDriver } from '../game/driver.ts';
import type { BoardView } from '../scene/types.ts';

export type RouteParams = { path: string[]; query: URLSearchParams };

export interface Settings {
  sound: boolean;
  haptics: boolean;
  quality: 'auto' | 'high' | 'low';
  name: string;
}

export interface GameScreenOptions {
  mode: 'local' | 'ai' | 'online' | 'live-match';
  orientation: Side;
  title: string;
  subtitle?: string;
  allowUndo?: boolean;
}

export interface GameScreenHandle {
  setTitle(title: string, subtitle?: string): void;
  setExtraActions(actions: { label: string; onClick: () => void }[]): void;
  dispose(): void;
}

export interface AppContext {
  root: HTMLElement;
  board(): Promise<BoardView>;
  navigate(hash: string): void;
  playGame(driver: GameDriver, opts: GameScreenOptions): GameScreenHandle;
  toast(message: string, kind?: 'info' | 'error' | 'success'): void;
  settings(): Settings;
  testMode: boolean;
}

export interface Screen {
  dispose(): void;
}

export type ScreenFactory = (ctx: AppContext, params: RouteParams) => Screen | Promise<Screen>;
