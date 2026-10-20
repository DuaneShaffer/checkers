import type { AppContext, GameScreenHandle, GameScreenOptions } from '../app/contracts.ts';
import { saveFinished } from '../app/persist.ts';
import { onSettingsChange, updateSettings } from '../app/settings.ts';
import { appState } from '../app/store.ts';
import { haptic, setHapticsEnabled } from '../audio/haptics.ts';
import { playSfx, setSoundEnabled } from '../audio/sfx.ts';
import { popcount } from '../engine/bitboard.ts';
import { fromFen, sidePieces } from '../engine/position.ts';
import type { Move, Position, Side } from '../engine/types.ts';
import type { ConnStatus, GameResult, OfferKind } from '../net/protocol.ts';
import { prefersReducedMotion } from '../ui/dom.ts';
import { type Hud, type HudModel, createHud } from '../ui/hud.ts';
import { type DialogAction, type DialogHandle, anyDialogOpen, confirmDialog, openDialog } from '../ui/modal.ts';
import { SIDE_NAMES, createAnnouncer, describeMove, describeReason, resultHeadline } from './announcer.ts';
import { type ControllerView, GameController } from './controller.ts';
import type { DriverSnapshot, GameDriver } from './driver.ts';
import { keyAction } from './keyboard.ts';
import { hasMoveBy } from './plies.ts';

export interface GameScreenExtras {
  onRematch?: () => void;
  onSnapshot?: (s: DriverSnapshot) => void;
  names?: Partial<Record<Side, string>>;
}

const CONNECTION_LABELS: Record<ConnStatus, string> = {
  idle: 'Offline',
  creating: 'Connecting…',
  'waiting-reply': 'Waiting for reply…',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  disconnected: 'Opponent offline',
  failed: 'Connection lost',
};

const other = (s: Side) => (1 - s) as Side;

export function defaultNames(mode: GameScreenOptions['mode'], snap: DriverSnapshot): Record<Side, string> {
  if (snap.mySides.length !== 1) return { 0: SIDE_NAMES[0], 1: SIDE_NAMES[1] };
  const me = snap.mySides[0];
  const them = mode === 'online' ? snap.online?.peerName || 'Friend' : mode === 'ai' ? 'AI' : SIDE_NAMES[other(me)];
  return me === 0 ? { 0: 'You', 1: them } : { 0: them, 1: 'You' };
}

export function capturedCounts(startFen: string, pos: Position): Record<Side, number> {
  const start = fromFen(startFen);
  const lost = (side: Side) => Math.max(0, popcount(sidePieces(start, side)) - popcount(sidePieces(pos, side)));
  return { 0: lost(1), 1: lost(0) };
}

function isTypingTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

export function mountGameScreen(ctx: AppContext, driver: GameDriver, opts: GameScreenOptions, extras: GameScreenExtras = {}): GameScreenHandle {
  const announcer = createAnnouncer(document.getElementById('announcer-polite'), document.getElementById('announcer-assertive'));
  let disposed = false;
  let soundOn = ctx.settings().sound;
  let resultDialog: DialogHandle | null = null;
  let offerDialog: { kind: OfferKind; handle: DialogHandle } | null = null;
  let lastResult: { result: GameResult; position: Position } | null = null;
  const animate = () => !ctx.testMode && !prefersReducedMotion();

  const canRematch = () => !!extras.onRematch || (opts.mode === 'online' && !!driver.offer);
  const savesFinishedGame = (mySides: readonly Side[]) => opts.mode !== 'live-match' && mySides.length > 0;
  const reviewAction = (): DialogAction => opts.mode === 'online'
    ? { label: 'Review', keepOpen: true, onSelect: () => void confirmLeaveForReview() }
    : { label: 'Review', onSelect: () => ctx.navigate('#/review') };
  const rematch = () => {
    resultDialog?.close();
    if (extras.onRematch) extras.onRematch();
    else if (driver.offer) {
      driver.offer('rematch');
      ctx.toast('Rematch offered');
    }
  };

  const hud: Hud = createHud({
    mode: opts.mode,
    title: opts.title,
    subtitle: opts.subtitle,
    actions: {
      home: () => ctx.navigate('#/'),
      flip: () => controller.flip(animate()),
      toggleSound: () => updateSettings({ sound: !soundOn }),
      undo: opts.allowUndo && driver.undo ? () => driver.undo?.() : undefined,
      resign: () => void confirmResign(),
      offerDraw: opts.mode === 'online' && driver.offer
        ? () => {
            driver.offer?.('draw');
            ctx.toast('Draw offered');
          }
        : undefined,
      rematch: canRematch() ? rematch : undefined,
      showResult: () => lastResult && showResult(lastResult.result, lastResult.position),
    },
  });
  ctx.root.append(hud.el);

  const controller = new GameController(driver, {
    orientation: opts.orientation,
    hooks: {
      change: render,
      moveShown,
      select: () => feedback('select'),
      hop: () => {
        playSfx('clack');
        haptic('move');
      },
      illegal: (reason) => {
        playSfx('illegal');
        haptic('illegal');
        if (reason === 'capture-required') ctx.toast('A jump is available — captures are mandatory.');
      },
      rejected: () => ctx.toast('That move could not be sent.', 'error'),
      gameOver: onGameOver,
      gameResumed: () => {
        resultDialog?.close();
        lastResult = null;
      },
    },
  });
  appState.activeGame = { controller, mode: opts.mode };

  const unsubSnapshot = extras.onSnapshot ? driver.subscribe(extras.onSnapshot) : () => undefined;
  const unsubSettings = onSettingsChange((s) => {
    soundOn = s.sound;
    setSoundEnabled(s.sound);
    setHapticsEnabled(s.haptics);
    render(controller.view());
  });

  void ctx.board().then(
    (board) => {
      if (disposed) return;
      board.setBoardSlot(hud.slot);
      board.setVisible(true);
      controller.attach(board);
    },
    (err) => {
      console.error(err);
      ctx.toast('The 3D board could not be loaded on this device.', 'error');
    },
  );

  function feedback(kind: 'select') {
    playSfx(kind);
    haptic(kind);
  }

  function moveShown(move: Move, mover: Side) {
    const capture = move.captured !== 0;
    playSfx(capture ? 'capture' : 'tap');
    haptic(capture ? 'capture' : 'move');
    if (move.promotes) {
      setTimeout(() => playSfx('crown'), 120);
      haptic('crown');
    }
    announcer.polite(describeMove(move, mover));
  }

  function onGameOver(result: GameResult, position: Position) {
    const snap = controller.snapshot;
    lastResult = { result, position };
    const mine = snap.mySides;
    const won = result.winner !== null && (mine.length !== 1 || mine.includes(result.winner));
    playSfx(result.winner === null || won ? 'win' : 'lose');
    const headline = resultHeadline(result, mine);
    announcer.assertive(`${headline}. ${describeReason(result, position)}.`);
    if (savesFinishedGame(mine)) {
      saveFinished({ mode: opts.mode, startFen: snap.startFen, moves: snap.moves, result, mySides: [...mine], orientation: mine.length === 1 ? mine[0] : opts.orientation, title: opts.title });
    }
    showResult(result, position);
  }

  function showResult(result: GameResult, position: Position) {
    resultDialog?.close();
    const snap = controller.snapshot;
    const plies = snap.moves.length;
    const captured = capturedCounts(snap.startFen, position);
    const names = { ...defaultNames(opts.mode, snap), ...extras.names };
    const stats = document.createElement('dl');
    stats.className = 'result-stats';
    for (const [label, value] of [
      ['Moves', String(Math.ceil(plies / 2))],
      [`${names[0]} captured`, String(captured[0])],
      [`${names[1]} captured`, String(captured[1])],
    ]) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      stats.append(dt, dd);
    }
    resultDialog = openDialog({
      className: 'result-dialog',
      eyebrow: opts.title,
      title: resultHeadline(result, snap.mySides),
      message: describeReason(result, position),
      body: stats,
      actions: [
        ...(canRematch() ? [{ label: 'Play again', kind: 'primary' as const, onSelect: rematch }] : []),
        ...(savesFinishedGame(snap.mySides) ? [reviewAction()] : []),
        { label: 'Home', kind: 'ghost' as const, onSelect: () => ctx.navigate('#/') },
      ],
      onClose: () => (resultDialog = null),
    });
  }

  async function confirmLeaveForReview() {
    const ok = await confirmDialog({
      title: 'Leave to review?',
      message: 'Reviewing ends the connection with your friend, so a rematch will no longer be possible.',
      confirm: 'Review',
    });
    if (ok && !disposed) ctx.navigate('#/review');
  }

  async function confirmResign() {
    const ok = await confirmDialog({ title: 'Resign this game?', message: 'Your opponent will be awarded the win.', confirm: 'Resign', danger: true });
    if (ok && !disposed) driver.resign();
  }

  function syncOfferDialog(snap: DriverSnapshot) {
    const incoming = snap.online?.incomingOffer;
    if (offerDialog && offerDialog.kind !== incoming) {
      offerDialog.handle.close();
      offerDialog = null;
    }
    if (!incoming || offerDialog || !driver.answer) return;
    const name = defaultNames(opts.mode, snap)[other(snap.mySides[0] ?? 0)];
    let answered = false;
    const reply = (accept: boolean) => {
      answered = true;
      driver.answer?.(incoming, accept);
    };
    if (incoming === 'rematch') resultDialog?.close();
    const handle = openDialog({
      title: incoming === 'draw' ? `${name} offers a draw` : `${name} wants a rematch`,
      message: incoming === 'rematch' ? 'Colors swap for the new game.' : undefined,
      actions: [
        { label: 'Decline', kind: 'ghost', onSelect: () => reply(false) },
        { label: 'Accept', kind: 'primary', onSelect: () => reply(true) },
      ],
      onClose: () => {
        if (offerDialog?.handle === handle) offerDialog = null;
        if (!answered && !disposed) driver.answer?.(incoming, false);
      },
    });
    offerDialog = { kind: incoming, handle };
  }

  function hudModel(view: ControllerView): HudModel {
    const snap = view.snapshot;
    const turn = view.position.turn;
    const names = { ...defaultNames(opts.mode, snap), ...extras.names };
    const over = view.status.over;
    const winner = view.status.over ? view.status.winner : null;
    const mine = snap.mySides;
    let status: string;
    if (view.status.over) status = resultHeadline({ winner: view.status.winner, reason: view.status.reason }, mine);
    else if (snap.thinking) status = `${names[turn]} is thinking…`;
    else if (view.canMove) {
      const base = mine.length === 1 ? 'Your move' : `${SIDE_NAMES[turn]} to move`;
      status = view.captureRequired ? `${base} · jump required` : base;
    } else if (mine.length > 0 && !mine.includes(turn)) status = `Waiting for ${names[turn]}`;
    else status = `${SIDE_NAMES[turn]} to move`;
    return {
      orientation: view.orientation,
      turn,
      names,
      captured: capturedCounts(snap.startFen, view.position),
      thinking: snap.thinking ? turn : null,
      over,
      winner,
      status,
      statusTone: over ? 'over' : view.captureRequired ? 'alert' : 'neutral',
      moves: snap.moves,
      firstMover: fromFen(snap.startFen).turn,
      canUndo: !!opts.allowUndo && !!driver.undo && hasMoveBy(snap, mine) && snap.result?.reason !== 'resign',
      canResign: !over && mine.length > 0,
      canOfferDraw: opts.mode === 'online' && !!driver.offer && !over && !snap.online?.outgoingOffer,
      canRematch: over && canRematch(),
      soundOn,
      connection: snap.online ? { status: snap.online.status, label: CONNECTION_LABELS[snap.online.status] } : undefined,
    };
  }

  function render(view: ControllerView) {
    if (disposed) return;
    hud.update(hudModel(view));
    syncOfferDialog(view.snapshot);
  }

  function onKey(e: KeyboardEvent) {
    if (disposed || anyDialogOpen() || isTypingTarget(e.target)) return;
    const action = keyAction(e);
    if (!action) return;
    const active = document.activeElement;
    const onBoard = !active || active === document.body || active === hud.slot;
    switch (action.kind) {
      case 'cursor':
        if (!onBoard) return;
        controller.moveCursor(action.dir);
        break;
      case 'activate':
        if (!onBoard) return;
        controller.activateCursor();
        break;
      case 'cancel':
        controller.cancel();
        break;
      case 'undo':
        if (!opts.allowUndo || !driver.undo) return;
        driver.undo();
        break;
      case 'flip':
        controller.flip(animate());
        break;
      case 'mute':
        updateSettings({ sound: !soundOn });
        break;
    }
    e.preventDefault();
  }
  document.addEventListener('keydown', onKey);

  render(controller.view());

  return {
    setTitle(title, subtitle) {
      hud.setTitle(title, subtitle);
    },
    setExtraActions(actions) {
      hud.setExtraActions(actions);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      document.removeEventListener('keydown', onKey);
      unsubSnapshot();
      unsubSettings();
      controller.dispose();
      resultDialog?.close();
      offerDialog?.handle.close();
      if (appState.activeGame?.controller === controller) appState.activeGame = null;
      hud.el.remove();
    },
  };
}
