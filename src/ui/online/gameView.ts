import type { AppContext, GameScreenHandle } from '../../app/contracts.ts';
import type { Side } from '../../engine/types.ts';
import type { DriverSnapshot } from '../../game/driver.ts';
import { SIDE_NAMES } from '../../game/announcer.ts';
import { inviteUrl } from '../../net/invite.ts';
import { OnlineDriver } from '../../net/onlineDriver.ts';
import type { DriverNotice } from '../../net/onlineDriver.ts';
import type { OnlineError } from '../../net/protocol.ts';
import { formatRoomCode } from '../../net/roomCode.ts';
import { isStoragePersistent, loadRoom } from '../../net/roomStore.ts';
import { PendingInvite, pendingInvite, takeLiveLink } from '../../net/rooms.ts';
import type { HandshakeStatus, RoomLock } from '../../net/rooms.ts';
import { sideOf } from '../../net/session.ts';
import { h } from '../dom.ts';
import { openDialog } from '../modal.ts';
import type { DialogHandle } from '../modal.ts';
import { ACCEPT_MESSAGES, COPY, button, callout, linkButton, linkPanel, pasteBox, spinner, statusLine } from './parts.ts';
import type { StatusLine } from './parts.ts';

const ERROR_COPY: Record<OnlineError['kind'], string> = {
  'ice-failed': COPY.timeout,
  timeout: COPY.timeout,
  'bad-link': COPY.badLink,
  'room-full': COPY.roomFull,
  'proto-mismatch': COPY.protoMismatch,
  'other-tab': COPY.otherTab,
  desync: COPY.desync,
};

export interface OnlineTestHook {
  code: string;
  role: string;
  status(): string;
  snapshot(): DriverSnapshot;
  resign(): void;
  offer(kind: 'draw' | 'rematch'): void;
  answer(kind: 'draw' | 'rematch', accept: boolean): void;
  openResume(): void;
}

declare module '../../app/testHook.ts' {
  interface CheckersTestHook {
    online?: OnlineTestHook;
  }
}

interface ResumeDialog {
  dialog: DialogHandle;
  panel: HTMLElement;
  status: StatusLine;
}

export class OnlineGameView {
  private readonly ctx: AppContext;
  private readonly code: string;
  private readonly lock: RoomLock;
  private readonly driver: OnlineDriver;
  private handle: GameScreenHandle | null = null;
  private mountedSide: Side | null = null;
  private readonly banner: HTMLElement;
  private readonly cleanup: (() => void)[] = [];
  private resumeDialog: ResumeDialog | null = null;
  private resumeInvite: PendingInvite | null = null;
  private resumeCreating: Promise<PendingInvite> | null = null;
  private offResumeStatus: (() => void) | null = null;
  private actionsKey = '';
  private titleKey = '';
  private bannerKey = '';
  private everConnected = false;
  private disposed = false;

  constructor(ctx: AppContext, code: string, lock: RoomLock, onLost: () => void) {
    this.ctx = ctx;
    this.code = code;
    this.lock = lock;
    this.driver = new OnlineDriver({ record: loadRoom(code)! });
    this.banner = h('div', { class: 'ol-banner', hidden: true, role: 'status', 'aria-live': 'polite' });
    const live = takeLiveLink(code);
    if (live) this.driver.attach(live);
    this.remount();
    this.cleanup.push(
      this.driver.subscribe((s) => this.onSnapshot(s)),
      this.driver.onNotice((n) => this.onNotice(n)),
      lock.onLost(onLost),
    );
    const onPageHide = () => this.driver.sendBye();
    window.addEventListener('pagehide', onPageHide);
    this.cleanup.push(() => window.removeEventListener('pagehide', onPageHide));
    if (ctx.testMode) this.installTestHook();
    if (!isStoragePersistent()) ctx.toast('This browser isn’t saving site data — reloading will lose this game.', 'info');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const fn of this.cleanup.splice(0)) fn();
    this.resumeDialog?.dialog.close();
    this.dropResumeInvite('orphan');
    this.handle?.dispose();
    this.handle = null;
    this.driver.dispose();
    this.banner.remove();
    this.ctx.root.querySelector(':scope > .ol-overlay:empty')?.remove();
    this.lock.release();
    const hook = window.__checkers;
    if (hook?.online?.code === this.code) delete hook.online;
  }

  private peerName(): string {
    return this.driver.state.peerName ?? 'your friend';
  }

  private mySide(): Side {
    const s = this.driver.state;
    if (s.game) return sideOf(s.role, s.game);
    return s.role === 'host' ? s.firstHostSide : ((1 - s.firstHostSide) as Side);
  }

  private remount(): void {
    const side = this.mySide();
    if (this.handle && side === this.mountedSide) return;
    this.handle?.dispose();
    this.mountedSide = side;
    this.titleKey = '';
    this.actionsKey = '';
    this.handle = this.ctx.playGame(this.driver, { mode: 'online', orientation: side, title: this.title(), subtitle: this.subtitle() });
    this.placeBanner();
    this.updateChrome(this.driver.snapshot());
  }

  private placeBanner(): void {
    const huds = this.ctx.root.querySelectorAll<HTMLElement>('.game-screen .hud-a');
    const hud = huds[huds.length - 1];
    if (hud) {
      const statusRow = hud.querySelector(':scope > .hud-status-row');
      if (statusRow) statusRow.after(this.banner);
      else hud.append(this.banner);
      return;
    }
    let overlay = this.ctx.root.querySelector<HTMLElement>(':scope > .ol-overlay');
    if (!overlay) {
      overlay = h('div', { class: 'ol-overlay' });
      this.ctx.root.append(overlay);
    }
    overlay.append(this.banner);
  }

  private title(): string {
    const name = this.driver.state.peerName;
    return name ? `vs ${name}` : 'Online game';
  }

  private subtitle(): string {
    return `${SIDE_NAMES[this.mySide()]} · ${formatRoomCode(this.code)}`;
  }

  private onSnapshot(s: DriverSnapshot): void {
    if (this.disposed) return;
    if (s.online?.status === 'connected') {
      this.everConnected = true;
      if (this.resumeInvite?.status === 'waiting') {
        this.resumeDialog?.dialog.close();
        this.dropResumeInvite('cancel');
      }
    }
    if (this.mySide() !== this.mountedSide) {
      queueMicrotask(() => {
        if (!this.disposed) this.remount();
      });
      return;
    }
    this.updateChrome(s);
  }

  private updateChrome(s: DriverSnapshot): void {
    const handle = this.handle;
    if (!handle) return;
    const title = this.title();
    const subtitle = this.subtitle();
    if (title + subtitle !== this.titleKey) {
      this.titleKey = title + subtitle;
      handle.setTitle(title, subtitle);
    }
    const status = s.online?.status ?? 'idle';
    const offline = status === 'disconnected' || status === 'idle' || (status === 'failed' && s.online?.error?.kind === 'desync');
    const key = offline ? 'resume' : '';
    if (key !== this.actionsKey) {
      this.actionsKey = key;
      handle.setExtraActions(offline ? [{ label: 'Resume link', onClick: () => this.openResume() }] : []);
    }
    this.renderBanner(s);
  }

  private renderBanner(s: DriverSnapshot): void {
    const online = s.online;
    const status = online?.status ?? 'idle';
    const error = online?.error;
    const awaitingReply = this.resumeInvite?.status === 'waiting';
    const key = `${status}|${error?.kind ?? ''}|${this.everConnected}|${this.peerName()}|${awaitingReply}`;
    if (key === this.bannerKey) return;
    this.bannerKey = key;
    const peer = this.peerName();
    const resume = () => button('Resume link', () => this.openResume(), 'primary', { 'data-action': 'resume-link' });
    let content: (Node | null)[] = [];
    let tone = 'wait';
    switch (status) {
      case 'connected':
        break;
      case 'connecting':
        content = [h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, `Connecting${this.everConnected ? '' : ` to ${peer}`}…`)];
        break;
      case 'reconnecting':
        content = [h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, 'Connection unstable — reconnecting…')];
        break;
      case 'idle':
      case 'disconnected':
        tone = 'warn';
        content = [h('span', { class: 'ol-banner-text' }, this.offlineText(s, awaitingReply)), resume()];
        break;
      case 'failed':
        tone = 'error';
        content = [h('span', { class: 'ol-banner-text' }, error ? ERROR_COPY[error.kind] : COPY.timeout), ...this.failureActions(error)];
        break;
      default:
        break;
    }
    this.banner.dataset.tone = tone;
    this.banner.dataset.status = status;
    this.banner.hidden = content.length === 0;
    this.banner.replaceChildren(...content.filter((n): n is Node => !!n));
  }

  private offlineText(s: DriverSnapshot, awaitingReply: boolean): string {
    const peer = this.peerName();
    if (awaitingReply) return `Link ready — waiting for ${peer}’s reply.`;
    if (this.everConnected || s.moves.length || this.driver.state.peerClientId) return `${capitalize(peer)} is offline — your game is saved.`;
    return 'Not connected yet — send your friend a link.';
  }

  private failureActions(error: OnlineError | undefined): HTMLElement[] {
    switch (error?.kind) {
      case 'room-full':
        return [linkButton('Start your own game', '#/friend', 'primary')];
      case 'proto-mismatch':
        return [button('Refresh', () => location.reload(), 'primary')];
      default:
        return [button('Resume link', () => this.openResume(), 'primary'), linkButton('Home', '#/', 'ghost')];
    }
  }

  private onNotice(n: DriverNotice): void {
    if (this.disposed) return;
    const peer = capitalize(this.peerName());
    switch (n) {
      case 'connected':
        this.ctx.toast(this.everConnected && this.driver.snapshot().moves.length ? 'Reconnected' : `Connected${this.driver.state.peerName ? ` to ${this.driver.state.peerName}` : ''}`, 'success');
        break;
      case 'disconnected':
        this.ctx.toast('Connection lost — your game is saved', 'error');
        break;
      case 'peer-left':
        this.ctx.toast(`${peer} left the game page`);
        break;
      case 'resynced':
        this.ctx.toast('Game resynchronized');
        break;
      case 'draw-cancelled':
        this.ctx.toast(`${peer} moved before your draw acceptance arrived — the game continues`);
        break;
      case 'draw-declined':
        this.ctx.toast(`${peer} declined the draw`);
        break;
      case 'rematch-declined':
        this.ctx.toast(`${peer} declined a rematch`);
        break;
      case 'game-started': {
        const game = this.driver.state.game;
        if (game && !game.id.startsWith('0.')) this.ctx.toast(`New game — you play ${SIDE_NAMES[sideOf(this.driver.state.role, game)]}`, 'success');
        break;
      }
      default:
        break;
    }
  }

  private openResume(): void {
    if (this.resumeDialog || this.disposed) return;
    const status = statusLine('Preparing a new link…');
    const panel = h('div', { class: 'ol-resume-link' }, h('div', { class: 'ol-progress-slot' }, spinner('Gathering connection details…')));
    const body = h('div', { class: 'ol-resume' },
      h('p', { class: 'ol-lede' }, `Your game is saved. Send this new link to ${this.peerName()}; they’ll send a reply link back — open it on this device or paste it below. Both of you need the game open.`),
      panel,
      status.el,
      callout('warn', COPY.keepGameOpen),
    );
    const dialog = openDialog({
      title: 'Reconnect with a new link',
      eyebrow: `Room ${formatRoomCode(this.code)}`,
      body,
      className: 'ol-resume-dialog',
      actions: [{ label: 'Close', kind: 'ghost' }],
      onClose: () => {
        if (this.resumeDialog?.dialog === dialog) this.resumeDialog = null;
      },
    });
    const view: ResumeDialog = { dialog, panel, status };
    this.resumeDialog = view;
    this.ensureResumeInvite().then(
      (invite) => {
        if (this.disposed || this.resumeDialog !== view) return;
        this.fillResumeDialog(view, invite);
      },
      (err) => {
        console.error(err);
        if (this.resumeDialog !== view) return;
        status.set('Couldn’t prepare a link. Check that you’re online and try again.', 'error');
        panel.replaceChildren();
      },
    );
  }

  private ensureResumeInvite(): Promise<PendingInvite> {
    const live = (inv: PendingInvite | null | undefined): inv is PendingInvite =>
      !!inv && (inv.status === 'waiting' || inv.status === 'connecting') && pendingInvite(this.code) === inv;
    if (live(this.resumeInvite)) return Promise.resolve(this.resumeInvite);
    if (this.resumeCreating) return this.resumeCreating;
    const state = this.driver.state;
    const orphaned = pendingInvite(this.code);
    if (live(orphaned) && orphaned.role === state.role) {
      this.trackResumeInvite(orphaned);
      return Promise.resolve(orphaned);
    }
    const creating = PendingInvite.create({ code: this.code, role: state.role, gameId: state.game?.id, name: state.name });
    this.resumeCreating = creating;
    void creating.then(
      (invite) => {
        if (this.resumeCreating === creating) this.resumeCreating = null;
        if (this.disposed) invite.orphan();
        else this.trackResumeInvite(invite);
      },
      () => {
        if (this.resumeCreating === creating) this.resumeCreating = null;
      },
    );
    return creating;
  }

  private trackResumeInvite(invite: PendingInvite): void {
    if (this.resumeInvite !== invite) this.dropResumeInvite('cancel');
    invite.adopt();
    this.resumeInvite = invite;
    this.offResumeStatus = invite.onStatus((s) => this.onResumeStatus(invite, s));
    this.renderBanner(this.driver.snapshot());
  }

  private dropResumeInvite(mode: 'cancel' | 'orphan'): void {
    const invite = this.resumeInvite;
    this.offResumeStatus?.();
    this.offResumeStatus = null;
    this.resumeInvite = null;
    if (invite && invite.status !== 'open') {
      if (mode === 'cancel') invite.cancel();
      else invite.orphan();
    }
    if (!this.disposed) this.renderBanner(this.driver.snapshot());
  }

  private onResumeStatus(invite: PendingInvite, s: HandshakeStatus): void {
    if (this.disposed || this.resumeInvite !== invite) return;
    const status = this.resumeDialog?.status;
    if (s === 'connecting') status?.set('Connecting…');
    else if (s === 'open') {
      this.offResumeStatus?.();
      this.offResumeStatus = null;
      this.resumeInvite = null;
      const link = invite.handOff();
      this.resumeDialog?.dialog.close();
      this.driver.attach(link);
    } else if (s === 'timeout' || s === 'closed') status?.set(COPY.timeout, 'error');
    this.renderBanner(this.driver.snapshot());
  }

  private fillResumeDialog(view: ResumeDialog, invite: PendingInvite): void {
    const paste = pasteBox({
      label: 'Got their reply? Paste it here',
      onSubmit: (text) => {
        paste.setBusy(true);
        void invite.accept(text).then((res) => {
          if (res === 'ok' || res === 'duplicate') return paste.clear();
          paste.setBusy(false);
          this.ctx.toast(ACCEPT_MESSAGES[res], 'error');
        });
      },
    });
    view.panel.replaceChildren(
      linkPanel({ url: inviteUrl(invite.blob), kind: 'invite', toast: this.ctx.toast, shareTitle: 'Checkers', shareText: 'Let’s finish our checkers game — open this to reconnect' }),
      paste.el,
    );
    if (invite.status === 'connecting') {
      paste.setBusy(true);
      view.status.set('Connecting…');
    } else view.status.set(`Waiting for ${this.peerName()}’s reply…`);
  }

  private installTestHook(): void {
    const hook = window.__checkers;
    if (!hook) return;
    const d = this.driver;
    hook.online = {
      code: this.code,
      role: d.role,
      status: () => d.status,
      snapshot: () => d.snapshot(),
      resign: () => d.resign(),
      offer: (k) => d.offer(k),
      answer: (k, a) => d.answer(k, a),
      openResume: () => this.openResume(),
    };
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
