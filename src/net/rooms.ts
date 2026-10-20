import type { Role, SignalPayload } from './protocol.ts';
import { messageId, openRoomChannel } from './roomChannel.ts';
import type { RoomChannel } from './roomChannel.ts';
import { RtcLink } from './rtcTransport.ts';
import { SignalError, blobFromLinkOrCode, decodeSignal, encodeSignal } from './signal.ts';
import { Listeners } from './transport.ts';

export const CONNECT_TIMEOUT_MS = 20_000;
const TAKEOVER_WAIT_MS = 4000;

export interface RoomLock {
  readonly code: string;
  release(): void;
  onLost(fn: () => void): () => void;
}

const heldLocks = new Map<string, RoomLock>();

type Release = () => void;

function requestWebLock(name: string, opts: LockOptions): Promise<Release | null> {
  return new Promise((resolve) => {
    navigator.locks
      .request(name, opts, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        return new Promise<void>((release) => resolve(release));
      })
      .catch(() => resolve(null));
  });
}

function locksSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.locks && typeof navigator.locks.request === 'function';
}

export async function acquireRoomLock(code: string, takeover = false): Promise<RoomLock | null> {
  const existing = heldLocks.get(code);
  if (existing) return existing;
  const name = `checkers-room-${code}`;
  let release: Release | null = () => {};
  if (locksSupported()) {
    release = await requestWebLock(name, { ifAvailable: true });
    if (!release && takeover) {
      const channel = openRoomChannel(code);
      channel.post({ type: 'takeover', id: messageId() });
      channel.close();
      release = await requestWebLock(name, { signal: AbortSignal.timeout(TAKEOVER_WAIT_MS) });
    }
  }
  if (!release) return null;
  const again = heldLocks.get(code);
  if (again) {
    release();
    return again;
  }
  return createHeldLock(code, release);
}

function createHeldLock(code: string, releaseLock: Release): RoomLock {
  const lost = new Listeners<void>();
  const channel = openRoomChannel(code);
  let released = false;
  const lock: RoomLock = {
    code,
    release() {
      if (released) return;
      released = true;
      heldLocks.delete(code);
      channel.close();
      lost.clear();
      releaseLock();
    },
    onLost: (fn) => lost.add(fn),
  };
  channel.on((msg) => {
    if (msg.type !== 'takeover' || released) return;
    lost.emit();
    lock.release();
  });
  heldLocks.set(code, lock);
  return lock;
}

const liveLinks = new Map<string, RtcLink>();

export function stashLiveLink(code: string, link: RtcLink): void {
  const old = liveLinks.get(code);
  if (old && old !== link) old.close();
  liveLinks.set(code, link);
}

export function takeLiveLink(code: string): RtcLink | undefined {
  const link = liveLinks.get(code);
  liveLinks.delete(code);
  return link && link.state !== 'closed' ? link : undefined;
}

export type HandshakeStatus = 'waiting' | 'connecting' | 'open' | 'timeout' | 'closed';
export type AcceptResult = 'ok' | 'duplicate' | 'bad-link' | 'wrong-room' | 'own-link' | 'expired';

export interface InviteOptions {
  code: string;
  role: Role;
  gameId?: string;
  name?: string;
}

const pendingInvites = new Map<string, PendingInvite>();

export function pendingInvite(code: string): PendingInvite | undefined {
  return pendingInvites.get(code);
}

export class PendingInvite {
  readonly code: string;
  readonly role: Role;
  readonly blob: string;
  readonly link: RtcLink;
  status: HandshakeStatus = 'waiting';
  peerName?: string;
  private readonly statuses = new Listeners<HandshakeStatus>();
  private readonly channel: RoomChannel;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private orphanTimer: ReturnType<typeof setTimeout> | undefined;
  private handedOff = false;

  private constructor(opts: InviteOptions, link: RtcLink, blob: string) {
    this.code = opts.code;
    this.role = opts.role;
    this.link = link;
    this.blob = blob;
    this.channel = openRoomChannel(opts.code);
    this.channel.on((msg) => {
      if (msg.type !== 'answer') return;
      void this.accept(msg.blob).then((res) => this.channel.post({ type: 'answer-ack', id: msg.id, ok: res === 'ok' || res === 'duplicate' }));
    });
    link.onState((state) => {
      if (state === 'open') this.setStatus('open');
      else if (state === 'closed') this.setStatus('closed');
    });
  }

  static async create(opts: InviteOptions): Promise<PendingInvite> {
    pendingInvites.get(opts.code)?.cancel();
    const { link, sdp } = await RtcLink.offer();
    const payload: SignalPayload = { v: 1, code: opts.code, role: opts.role, sdp };
    if (opts.gameId) payload.gameId = opts.gameId;
    if (opts.name) payload.name = opts.name;
    const invite = new PendingInvite(opts, link, await encodeSignal(payload));
    pendingInvites.set(opts.code, invite);
    return invite;
  }

  onStatus(fn: (s: HandshakeStatus) => void): () => void {
    return this.statuses.add(fn);
  }

  async accept(input: string): Promise<AcceptResult> {
    if (this.status === 'connecting' || this.status === 'open') return 'duplicate';
    if (this.status !== 'waiting' || !this.link.awaitingAnswer) return 'expired';
    const blob = blobFromLinkOrCode(input);
    if (!blob) return 'bad-link';
    let payload: SignalPayload;
    try {
      payload = await decodeSignal(blob);
    } catch (e) {
      if (e instanceof SignalError) return 'bad-link';
      throw e;
    }
    if (payload.code !== this.code) return 'wrong-room';
    if (payload.role === this.role) return 'own-link';
    if (this.status !== 'waiting' || !this.link.awaitingAnswer) return 'duplicate';
    try {
      await this.link.acceptAnswer(payload.sdp);
    } catch {
      return this.link.awaitingAnswer ? 'bad-link' : 'duplicate';
    }
    this.peerName = payload.name;
    if (this.link.state === 'open') this.setStatus('open');
    else {
      this.setStatus('connecting');
      this.timer = setTimeout(() => {
        if (this.status === 'connecting') this.setStatus('timeout');
      }, CONNECT_TIMEOUT_MS);
    }
    return 'ok';
  }

  orphan(graceMs = 5000): void {
    clearTimeout(this.orphanTimer);
    this.orphanTimer = setTimeout(() => this.cancel(), graceMs);
  }

  adopt(): void {
    clearTimeout(this.orphanTimer);
  }

  handOff(): RtcLink {
    this.handedOff = true;
    this.dispose();
    return this.link;
  }

  cancel(): void {
    this.dispose();
    if (!this.handedOff) this.link.close();
  }

  private dispose(): void {
    clearTimeout(this.timer);
    clearTimeout(this.orphanTimer);
    this.channel.close();
    this.statuses.clear();
    if (pendingInvites.get(this.code) === this) pendingInvites.delete(this.code);
  }

  private setStatus(status: HandshakeStatus): void {
    if (this.status === status) return;
    if (status === 'open') clearTimeout(this.timer);
    this.status = status;
    this.statuses.emit(status);
  }
}

export interface ReplyResult {
  link: RtcLink;
  blob: string;
}

export async function answerInvite(offer: SignalPayload, opts: InviteOptions): Promise<ReplyResult> {
  const { link, sdp } = await RtcLink.answer(offer.sdp);
  const payload: SignalPayload = { v: 1, code: opts.code, role: opts.role, sdp };
  if (opts.gameId) payload.gameId = opts.gameId;
  if (opts.name) payload.name = opts.name;
  return { link, blob: await encodeSignal(payload) };
}
