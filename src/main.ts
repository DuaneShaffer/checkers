import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/home.css';
import './styles/hud.css';

import type { AppContext, Screen, ScreenFactory } from './app/contracts.ts';
import { type Route, type RouteName, createHashRouter } from './app/router.ts';
import { getSettings, onSettingsChange } from './app/settings.ts';
import { appState } from './app/store.ts';
import { installTestHook } from './app/testHook.ts';
import { setHapticsEnabled } from './audio/haptics.ts';
import { installAudioUnlock, setSoundEnabled } from './audio/sfx.ts';
import { mountGameScreen } from './game/gameScreen.ts';
import type { BoardViewExt } from './scene/boardView.ts';
import type { BoardView } from './scene/types.ts';
import { h } from './ui/dom.ts';
import { homeScreen } from './ui/home.ts';
import { closeAllDialogs } from './ui/modal.ts';
import { createToaster } from './ui/toast.ts';

const SCREENS: Record<RouteName, () => Promise<ScreenFactory>> = {
  home: async () => homeScreen,
  ai: () => import('./game/screens.ts').then((m) => m.aiScreen),
  local: () => import('./game/screens.ts').then((m) => m.localScreen),
  review: () => import('./game/screens.ts').then((m) => m.reviewScreen),
  friend: () => import('./ui/online/screens.ts').then((m) => m.friendScreen),
  join: () => import('./ui/online/screens.ts').then((m) => m.joinScreen),
  answer: () => import('./ui/online/screens.ts').then((m) => m.answerScreen),
  play: () => import('./ui/online/screens.ts').then((m) => m.onlineGameScreen),
  lab: () => import('./lab/labView.ts').then((m) => m.labScreen),
};

function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el;
}

const testMode = new URLSearchParams(location.search).get('test') === '1';
const stageHost = requireEl('stage');
const root = requireEl('ui');
const toaster = createToaster(requireEl('toasts'));

let boardPromise: Promise<BoardViewExt> | null = null;
let renderToken = 0;
let boardClaimedBy = -1;

function loadBoard(): Promise<BoardViewExt> {
  boardPromise ??= import('./scene/boardView.ts')
    .then((m) => m.createBoardViewExt(stageHost, { testMode, quality: getSettings().quality }))
    .then((board) => {
      if (testMode) board.setInstantAnimations(true);
      appState.board = board;
      if (boardClaimedBy !== renderToken) hideBoard(board);
      return board;
    });
  boardPromise.catch(() => (boardPromise = null));
  return boardPromise;
}

const router = createHashRouter((route) => void show(route));

const ctx: AppContext = {
  root,
  testMode,
  board() {
    boardClaimedBy = renderToken;
    return loadBoard();
  },
  navigate: (hash) => router.navigate(hash),
  playGame: (driver, opts) => mountGameScreen(ctx, driver, opts),
  toast: (message, kind) => toaster.show(message, kind),
  settings: getSettings,
};

let current: Screen | null = null;
let settled: Promise<void> = Promise.resolve();

function show(route: Route): Promise<void> {
  const token = renderToken + 1;
  delete document.body.dataset.ready;
  settled = render(route).then(() => markReady(token));
  return settled;
}

async function markReady(token: number): Promise<void> {
  if (boardClaimedBy === token && boardPromise) await boardPromise.catch(() => undefined);
  await nextFrame();
  await nextFrame();
  if (token === renderToken) document.body.dataset.ready = '1';
}

async function render(route: Route): Promise<void> {
  const token = ++renderToken;
  closeAllDialogs();
  const previous = current;
  current = null;
  try {
    previous?.dispose();
  } catch (err) {
    console.error(err);
  }
  root.replaceChildren();
  appState.route = route.name;
  document.documentElement.dataset.route = route.name;
  try {
    const factory = await SCREENS[route.name]();
    if (token !== renderToken) return;
    const screen = await factory(ctx, route.params);
    if (token !== renderToken) {
      screen.dispose();
      return;
    }
    current = screen;
  } catch (err) {
    console.error(err);
    if (token === renderToken) current = errorScreen();
  }
  if (token !== renderToken) return;
  if (boardClaimedBy !== token && appState.board) hideBoard(appState.board);
}

function hideBoard(board: BoardView): void {
  board.setBoardSlot(null);
  board.setVisible(false);
}

function errorScreen(): Screen {
  const el = h('section', { class: 'screen empty-screen' },
    h('div', { class: 'panel empty-card' },
      h('h1', { class: 'display' }, 'This page didn’t load'),
      h('p', {}, 'Check your connection and try again.'),
      h('div', { class: 'empty-actions' },
        h('button', { type: 'button', class: 'btn', onClick: () => location.reload() }, 'Reload'),
        h('a', { class: 'btn btn-primary', href: '#/' }, 'Home'),
      ),
    ),
  );
  root.append(el);
  return { dispose: () => el.remove() };
}

let appliedQuality = getSettings().quality;

function applySettings(): void {
  const s = getSettings();
  setSoundEnabled(s.sound);
  setHapticsEnabled(s.haptics);
  if (s.quality !== appliedQuality) {
    appliedQuality = s.quality;
    void boardPromise?.then((board) => board.setQuality(s.quality), () => undefined);
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

applySettings();
onSettingsChange(applySettings);
installAudioUnlock();
if (testMode) document.documentElement.classList.add('test-mode');
router.start();
if (testMode) installTestHook(() => settled);
