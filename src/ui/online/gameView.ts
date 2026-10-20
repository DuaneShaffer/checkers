import type { AppContext, GameScreenHandle } from '../../app/contracts.ts';
import type { Side } from '../../engine/types.ts';
import type { DriverSnapshot } from '../../game/driver.ts';
import { inviteUrl } from '../../net/invite.ts';
import { OnlineDriver } from '../../net/onlineDriver.ts';
import type { DriverNotice } from '../../net/onlineDriver.ts';
import type { OnlineError } from '../../net/protocol.ts';
import { formatRoomCode } from '../../net/roomCode.ts';
import { isStoragePersistent, loadRoom } from '../../net/roomStore.ts';
import { PendingInvite, pendingInvite, takeLiveLink } from '../../net/rooms.ts';
import type { RoomLock } from '../../net/rooms.ts';
import { sideOf } from '../../net/session.ts';
import { h } from '../dom.ts';
import { openDialog } from '../modal.ts';
import type { DialogHandle } from '../modal.ts';
import { ACCEPT_MESSAGES, COPY, SIDE_LABEL, button, linkButton, linkPanel, pasteBox, spinner, statusLine } from './parts.ts';

const ERROR_COPY: Record<OnlineError['kind'], string> = {
  'ice-failed': COPY.timeout,
  timeout: COPY.timeout,
  'bad-link': COPY.badLink,
  'room-full': COPY.roomFull,
  'proto-mismatch': COPY.protoMismatch,
  'other-tab': COPY.otherTab,
  desync: COPY.desync,
};

interface OnlineTestHook {
  code: string;
  role: string;
  status(): string;
  snapshot(): DriverSnapshot;
  playMove(move: string): boolean;
  resign(): void;
  offer(kind: 'draw' | 'rematch'): void;
  answer(kind: 'draw' | 'rematch', accept: boolean): void;
  openResume(): void;
}

declare global {
  interface Window {
    __checkersOnline?: OnlineTestHook;
  }
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
  private resumeDialog: { dialog: DialogHandle; invite: PendingInvite } | null = null;
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
    ctx.root.append(h('div', { class: 'ol-overlay' }, this.banner));
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
    this.closeResume('orphan');
    this.handle?.dispose();
    this.handle = null;
    this.driver.dispose();
    this.banner.parentElement?.remove();
    this.lock.release();
    if (window.__checkersOnline?.code === this.code) delete window.__checkersOnline;
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
    this.updateChrome(this.driver.snapshot());
  }

  private title(): string {
    const name = this.driver.state.peerName;
    return name ? `vs ${name}` : 'Online game';
  }

  private subtitle(): string {
    return `You play ${SIDE_LABEL[this.mySide()]} · Room ${formatRoomCode(this.code)}`;
  }

  private onSnapshot(s: DriverSnapshot): void {
    if (this.disposed) return;
    if (s.online?.status === 'connected') {
      this.everConnected = true;
      if (this.resumeDialog?.invite.status === 'waiting') this.closeResume('cancel');
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
    const key = `${status}|${error?.kind ?? ''}|${this.everConnected}|${this.peerName()}`;
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
        content = [h('span', { class: 'ol-spinner', 'aria-hidden': 'true' }), h('span', {}, `Connecting${this.everConnected ? '' : ` to ${peer}`}…`)];
        break;
      case 'reconnecting':
        content = [h('span', { class: 'ol-spinner', 'aria-hidden': 'true' }), h('span', {}, 'Connection unstable — reconnecting…')];
        break;
      case 'idle':
      case 'disconnected':
        tone = 'warn';
        content = [h('span', { class: 'ol-banner-text' }, this.everConnected || s.moves.length || this.driver.state.peerClientId ? `${capitalize(peer)} is offline — your game is saved.` : 'Not connected yet — send your friend a link.'), resume()];
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
        if (game && !game.id.startsWith('0.')) this.ctx.toast(`New game — you play ${SIDE_LABEL[sideOf(this.driver.state.role, game)]}`, 'success');
        break;
      }
      default:
        break;
    }
  }

  private openResume(): void {
    if (this.resumeDialog) return;
    const state = this.driver.state;
    const status = statusLine('Preparing a new link…');
    const panel = h('div', { class: 'ol-resume-link' }, h('div', { class: 'ol-progress-slot' }, spinner('Gathering connection details…')));
    const body = h('div', { class: 'ol-resume' },
      h('p', { class: 'ol-lede' }, `Your game is saved. Send this new link to ${this.peerName()}; they’ll send a reply link back — open it on this device or paste it below. Both of you need the game open.`),
      panel,
      status.el,
    );
    const dialog = openDialog({
      title: 'Reconnect with a new link',
      eyebrow: `Room ${formatRoomCode(this.code)}`,
      body,
      className: 'ol-resume-dialog',
      actions: [{ label: 'Close', kind: 'ghost' }],
      onClose: () => queueMicrotask(() => this.closeResume(this.disposed ? 'orphan' : 'cancel')),
    });
    const existing = pendingInvite(this.code);
    const ready = existing && existing.status === 'waiting' && existing.role === state.role
      ? Promise.resolve(existing)
      : PendingInvite.create({ code: this.code, role: state.role, gameId: state.game?.id, name: state.name });
    ready.then(
      (invite) => {
        if (this.disposed || !dialog.el.isConnected) {
          if (!this.disposed) invite.cancel();
          return;
        }
        invite.adopt();
        this.resumeDialog = { dialog, invite };
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
        panel.replaceChildren(
          linkPanel({ url: inviteUrl(invite.blob), kind: 'invite', toast: this.ctx.toast, shareTitle: 'Checkers', shareText: 'Let’s finish our checkers game — open this to reconnect' }),
          paste.el,
        );
        status.set(`Waiting for ${this.peerName()}’s reply…`);
        invite.onStatus((s) => {
          if (this.disposed) return;
          if (s === 'connecting') status.set('Connecting…');
          else if (s === 'open') {
            const link = invite.handOff();
            this.resumeDialog = null;
            dialog.close();
            this.driver.attach(link);
          } else if (s === 'timeout' || s === 'closed') status.set(COPY.timeout, 'error');
        });
      },
      (err) => {
        console.error(err);
        status.set('Couldn’t prepare a link. Check that you’re online and try again.', 'error');
        panel.replaceChildren();
      },
    );
  }

  private closeResume(invite: 'cancel' | 'orphan'): void {
    const current = this.resumeDialog;
    this.resumeDialog = null;
    if (!current) return;
    if (current.invite.status !== 'open') {
      if (invite === 'cancel') current.invite.cancel();
      else current.invite.orphan();
    }
    current.dialog.close();
  }

  private installTestHook(): void {
    const d = this.driver;
    window.__checkersOnline = {
      code: this.code,
      role: d.role,
      status: () => d.status,
      snapshot: () => d.snapshot(),
      playMove: (m) => d.submitMove(m),
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
