// Stand-in shell for developing the Lab before the real router/scene exist. Not shipped.
import '@fontsource-variable/fraunces';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '../../../../src/styles/tokens.css';
import type { AppContext, GameScreenHandle, Screen } from '../../../../src/app/contracts.ts';
import { parseHash } from '../../../../src/app/router.ts';
import type { GameDriver } from '../../../../src/game/driver.ts';
import { labScreen } from '../../../../src/lab/labView.ts';

const root = document.getElementById('app')!;
const toasts = document.createElement('div');
toasts.className = 'harness-toasts';
document.body.append(toasts);

function playGame(driver: GameDriver, opts: { title: string; subtitle?: string }): GameScreenHandle {
  const el = document.createElement('div');
  el.className = 'harness-live';
  el.dataset.testid = 'harness-live';
  const title = document.createElement('h1');
  const sub = document.createElement('p');
  const moves = document.createElement('p');
  moves.dataset.testid = 'harness-live-moves';
  const actions = document.createElement('div');
  el.append(title, sub, actions, moves);
  root.append(el);
  const setTitle = (t: string, s?: string) => { title.textContent = t; sub.textContent = s ?? ''; };
  setTitle(opts.title, opts.subtitle);
  const unsub = driver.subscribe((snap) => {
    moves.textContent = `${snap.moves.length} plies: ${snap.moves.join(' ')}${snap.result ? ` — result ${JSON.stringify(snap.result)}` : ''}${snap.thinking ? ' (thinking)' : ''}`;
  });
  return {
    setTitle,
    setExtraActions(list) {
      actions.replaceChildren(...list.map((a) => {
        const b = document.createElement('button');
        b.textContent = a.label;
        b.onclick = a.onClick;
        return b;
      }));
    },
    dispose() {
      unsub();
      el.remove();
    },
  };
}

const ctx: AppContext = {
  root,
  board: () => Promise.reject(new Error('No 3D board in the harness')),
  navigate: (hash) => { location.hash = hash; },
  playGame,
  toast(message) {
    const t = document.createElement('div');
    t.textContent = message;
    toasts.append(t);
    setTimeout(() => t.remove(), 4000);
  },
  settings: () => ({ sound: false, haptics: false, quality: 'low', name: '' }),
  testMode: new URLSearchParams(location.search).has('test'),
};

let current: Screen | null = null;

async function route(): Promise<void> {
  current?.dispose();
  current = null;
  const r = parseHash(location.hash);
  if (r.name !== 'lab') {
    location.hash = '#/lab';
    return;
  }
  current = await labScreen(ctx, r.params);
}

window.addEventListener('hashchange', () => void route());
void route();
