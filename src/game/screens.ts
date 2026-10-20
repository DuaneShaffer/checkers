import { LEVELS, type LevelId } from '../ai/levels.ts';
import type { AiClientApi } from '../ai/protocol.ts';
import type { AppContext, GameScreenHandle, Screen, ScreenFactory } from '../app/contracts.ts';
import { type ResumeRecord, clearResume, findResume, loadFinished, newResumeId, saveResume } from '../app/persist.ts';
import { aiHash, formatHash, parseAiParams } from '../app/router.ts';
import { Game } from '../engine/game.ts';
import { INITIAL_FEN, isValidFen } from '../engine/position.ts';
import type { Side } from '../engine/types.ts';
import { isTrainingManifest } from '../shared/formats.ts';
import { patientTimeout } from '../shared/patientTimeout.ts';
import { h } from '../ui/dom.ts';
import { type DialogHandle, openDialog } from '../ui/modal.ts';
import { resultHeadline } from './announcer.ts';
import { type AiEngine, AiDriver } from './aiDriver.ts';
import type { DriverSnapshot } from './driver.ts';
import { mountGameScreen } from './gameScreen.ts';
import { hasMoveBy } from './plies.ts';
import { LocalDriver } from './localDriver.ts';
import { ReviewDriver } from './reviewDriver.ts';

const trainingUrl = (path: string) => `${import.meta.env.BASE_URL}training/${path}`;

export interface ResolvedEngine {
  engine: AiEngine;
  label: string;
}

export const MANIFEST_TIMEOUT_MS = 8000;

async function fetchManifest(): Promise<unknown> {
  const abort = new AbortController();
  const cancelTimer = patientTimeout(MANIFEST_TIMEOUT_MS, () => abort.abort());
  try {
    const res = await fetch(trainingUrl('manifest.json'), { cache: 'no-cache', signal: abort.signal });
    return res.ok ? await res.json() : null;
  } finally {
    cancelTimer();
  }
}

export async function resolveEngine(client: AiClientApi, gen: number | null, notify: (msg: string) => void): Promise<ResolvedEngine> {
  const heuristic: ResolvedEngine = { engine: { client, netId: 'heuristic' }, label: 'Heuristic engine' };
  try {
    const manifest = await fetchManifest();
    if (!isTrainingManifest(manifest)) return heuristic;
    const target = gen ?? manifest.champion;
    const entry = target === null ? undefined : manifest.generations.find((g) => g.gen === target && g.net);
    if (!entry?.net) {
      if (gen !== null) notify(`Generation ${gen} has no saved network, so the built-in heuristic is playing.`);
      return heuristic;
    }
    const netId = `gen-${entry.gen}`;
    await client.loadNet(netId, trainingUrl(entry.net));
    return { engine: { client, netId }, label: `Neural net · gen ${entry.gen}` };
  } catch (err) {
    console.warn('Falling back to the heuristic engine', err);
    return heuristic;
  }
}

function validFenParam(fen: string | null, ctx: AppContext): string | null {
  if (!fen) return null;
  if (isValidFen(fen)) return fen;
  ctx.toast(INVALID_FEN_MESSAGE, 'error');
  return null;
}

function brokenSave(ctx: AppContext): Screen {
  clearResume();
  ctx.toast('The saved game could not be restored.', 'error');
  ctx.navigate('#/');
  return { dispose() {} };
}

function lookupResume(ctx: AppContext, token: string | null, mode: ResumeRecord['mode'], freshHash: string): ResumeRecord | null {
  const found = findResume(token, mode);
  if (found !== 'gone') return found;
  ctx.toast('That saved game is no longer available, so a new game has started.');
  history.replaceState(history.state, '', freshHash);
  return null;
}

type ResumeBase = Omit<ResumeRecord, 'v' | 'savedAt' | 'startFen' | 'moves'>;

function persistTo(base: ResumeBase, humanSides: readonly Side[], resumeHash: string, resumed: boolean) {
  let ownsRecord = resumed;
  return (s: DriverSnapshot) => {
    if (s.result || !hasMoveBy(s, humanSides)) {
      if (ownsRecord) clearResume();
      return;
    }
    saveResume({ ...base, startFen: s.startFen, moves: s.moves });
    ownsRecord = true;
    if (location.hash !== resumeHash) history.replaceState(history.state, '', resumeHash);
  };
}

const INVALID_FEN_MESSAGE = 'That position link is invalid, so the game starts from the opening.';

export const aiScreen: ScreenFactory = (ctx, params) => {
  const opts = parseAiParams(params.query);
  if (params.query.get('fen') && !opts.fen) ctx.toast(INVALID_FEN_MESSAGE, 'error');
  const record = lookupResume(ctx, opts.resume, 'ai', aiHash({ ...opts, resume: null }));
  const humanSide: Side = record?.humanSide ?? (opts.side === 'r' ? (Math.random() < 0.5 ? 0 : 1) : opts.side);
  const levelId: LevelId = record?.level ?? opts.level;
  const gen = record ? record.gen ?? null : opts.gen;
  const resumeId = record?.id ?? newResumeId();
  const level = LEVELS[levelId];
  const aiSide = (1 - humanSide) as Side;
  const title = `vs AI · ${level.name}`;

  let handle: GameScreenHandle | undefined;
  let stallDialog: DialogHandle | null = null;
  const clients: Promise<AiClientApi>[] = [];
  const loadEngine = async (): Promise<AiEngine> => {
    handle?.setTitle(title, 'Loading engine…');
    const client = import('../ai/client.ts').then((m) => new m.AiClient() as AiClientApi);
    clients.push(client);
    try {
      const resolved = await resolveEngine(await client, gen, (msg) => ctx.toast(msg));
      handle?.setTitle(title, resolved.label);
      return resolved.engine;
    } catch (err) {
      handle?.setTitle(title, 'Engine unavailable');
      throw err;
    }
  };

  let driver: AiDriver;
  try {
    driver = new AiDriver({
      engine: loadEngine,
      humanSide,
      level,
      startFen: record?.startFen ?? opts.fen ?? INITIAL_FEN,
      moves: record?.moves ?? [],
      onError: (err) => {
        console.error(err);
        showStall();
      },
    });
  } catch {
    return brokenSave(ctx);
  }

  function showStall() {
    if (stallDialog) return;
    const canUndo = hasMoveBy(driver.snapshot(), [humanSide]);
    stallDialog = openDialog({
      title: 'The AI couldn’t move',
      message: 'Its engine failed to load or answer. Check your connection, then try again.',
      dismissible: false,
      actions: [
        { label: 'Home', kind: 'ghost', onSelect: () => ctx.navigate('#/') },
        ...(canUndo ? [{ label: 'Undo my move', onSelect: () => driver.undo() }] : []),
        { label: 'Try again', kind: 'primary', onSelect: () => driver.retry() },
      ],
      onClose: () => (stallDialog = null),
    });
  }

  handle = mountGameScreen(ctx, driver, { mode: 'ai', orientation: humanSide, title, subtitle: 'Loading engine…', allowUndo: true }, {
    names: { [humanSide]: 'You', [aiSide]: `AI · ${level.name}` } as Record<Side, string>,
    onRematch: () => ctx.navigate(aiHash({ level: levelId, side: !record && opts.side === 'r' ? 'r' : humanSide, gen, fen: opts.fen })),
    onSnapshot: persistTo(
      { mode: 'ai', id: resumeId, humanSide, level: levelId, gen },
      [humanSide],
      aiHash({ level: levelId, side: humanSide, gen, fen: opts.fen, resume: resumeId }),
      record !== null,
    ),
  });
  const screenHandle = handle;

  return {
    dispose() {
      stallDialog?.close();
      screenHandle.dispose();
      driver.dispose();
      for (const client of clients) void client.then((c) => c.dispose(), () => undefined);
    },
  };
};

export const localScreen: ScreenFactory = (ctx, params) => {
  const fen = validFenParam(params.query.get('fen'), ctx);
  const record = lookupResume(ctx, params.query.get('resume'), 'local', formatHash(['local'], { fen }));
  const resumeId = record?.id ?? newResumeId();
  let driver: LocalDriver;
  try {
    driver = new LocalDriver({ startFen: record?.startFen ?? fen ?? undefined, moves: record?.moves });
  } catch {
    return brokenSave(ctx);
  }
  const handle = mountGameScreen(ctx, driver, { mode: 'local', orientation: 0, title: 'Pass & play', subtitle: 'Two players, one device', allowUndo: true }, {
    onRematch: () => ctx.navigate('#/local'),
    onSnapshot: persistTo({ mode: 'local', id: resumeId }, [0, 1], formatHash(['local'], { fen, resume: resumeId }), record !== null),
  });
  return {
    dispose() {
      handle.dispose();
      driver.dispose();
    },
  };
};

export const reviewScreen: ScreenFactory = (ctx) => {
  const last = loadFinished();
  if (!last) return emptyReview(ctx);
  try {
    Game.fromMoves(last.moves, { startFen: last.startFen });
  } catch {
    return emptyReview(ctx);
  }
  const driver = new ReviewDriver(last.startFen, last.moves);
  const mine: Side[] = last.mySides ?? (last.mode === 'ai' || last.mode === 'online' ? [last.orientation] : [0, 1]);
  const subtitle = `${last.title} · ${resultHeadline(last.result, mine)}`;
  const handle = mountGameScreen(ctx, driver, { mode: 'review', orientation: last.orientation, title: 'Review', subtitle });
  handle.setExtraActions([
    { label: 'Start', onClick: () => driver.seek(0) },
    { label: 'Back', onClick: () => driver.step(-1) },
    { label: 'Next', onClick: () => driver.step(1) },
    { label: 'End', onClick: () => driver.seek(Infinity) },
  ]);
  return {
    dispose() {
      handle.dispose();
      driver.dispose();
    },
  };
};

function emptyReview(ctx: AppContext): Screen {
  const el = h('section', { class: 'screen empty-screen' },
    h('div', { class: 'panel empty-card' },
      h('h1', { class: 'display' }, 'Nothing to review yet'),
      h('p', {}, 'Finish a game and it will be waiting here.'),
      h('a', { class: 'btn btn-primary', href: '#/' }, 'Back to home'),
    ),
  );
  ctx.root.append(el);
  return { dispose: () => el.remove() };
}
