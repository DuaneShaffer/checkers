import { INITIAL_FEN } from '../engine/position.ts';
import type { DriverSnapshot, GameDriver, OnlineSnapshot } from '../game/driver.ts';
import type { ConnStatus, OfferKind, OnlineError, Role, WireMsg } from './protocol.ts';
import { saveRoom } from './roomStore.ts';
import type { RoomRecord } from './roomStore.ts';
import { createSession, incomingOffer, outgoingOffer, sideOf, step } from './session.ts';
import type { Notice, SessionEvent, SessionState } from './session.ts';
import type { Transport } from './transport.ts';

export const PING_INTERVAL_MS = 3000;
export const STALL_AFTER_MS = 6000;
export const LOST_AFTER_MS = 10_000;
export const GIVE_UP_AFTER_MS = 120_000;
const TIMER_MS = PING_INTERVAL_MS / 3;
const FROZEN_GAP_MS = TIMER_MS * 3;

export interface Clock {
  now(): number;
  every(ms: number, fn: () => void): () => void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  every(ms, fn) {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
};

export function randomGameId(seq: number): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(36).padStart(2, '0')).join('');
  return `${seq.toString(36)}.${rand}`;
}

export interface OnlineDriverOptions {
  record: RoomRecord;
  save?: (record: RoomRecord) => void;
  clock?: Clock;
  newGameId?: (seq: number) => string;
}

export type DriverNotice = Notice | 'connected' | 'disconnected';

const FATAL: ReadonlySet<OnlineError['kind']> = new Set(['room-full', 'proto-mismatch', 'desync']);

export class OnlineDriver implements GameDriver {
  readonly code: string;
  readonly role: Role;
  private session: SessionState;
  private record: RoomRecord;
  private link: Transport | null = null;
  private unlink: (() => void)[] = [];
  private stalled = false;
  private lost = false;
  private lastHeard = 0;
  private lastPingAt = 0;
  private lastTimerAt = 0;
  private rttMs: number | undefined;
  private readonly pingSent = new Map<number, number>();
  private readonly listeners = new Set<(s: DriverSnapshot) => void>();
  private readonly noticeListeners = new Set<(n: DriverNotice) => void>();
  private cached: DriverSnapshot | null = null;
  private readonly save: (record: RoomRecord) => void;
  private readonly clock: Clock;
  private readonly newGameId: (seq: number) => string;
  private stopTimer: () => void;
  private disposed = false;
  private wasConnected = false;
  private lastSaved = '';

  constructor(opts: OnlineDriverOptions) {
    this.record = opts.record;
    this.code = opts.record.code;
    this.role = opts.record.role;
    this.save = opts.save ?? ((r) => void saveRoom(r));
    this.clock = opts.clock ?? realClock;
    this.newGameId = opts.newGameId ?? randomGameId;
    this.session = createSession({
      role: this.record.role,
      clientId: this.record.clientId,
      name: this.record.name,
      peerClientId: this.record.peerClientId,
      peerName: this.record.peerName,
      firstHostSide: this.record.firstHostSide,
      game: this.record.game,
      offer: this.record.offer,
    });
    this.lastSaved = this.persistKey();
    this.lastTimerAt = this.clock.now();
    this.stopTimer = this.clock.every(TIMER_MS, () => this.onTimer());
  }

  get state(): SessionState {
    return this.session;
  }

  get status(): ConnStatus {
    const err = this.session.error;
    if (err && FATAL.has(err.kind)) return 'failed';
    const link = this.link;
    if (!link || link.state === 'closed') return this.wasConnected || this.session.game ? 'disconnected' : 'idle';
    if (this.lost) return 'disconnected';
    if (link.state === 'connecting') return 'connecting';
    if (link.state === 'reconnecting') return 'reconnecting';
    if (this.session.link !== 'ready') return this.wasConnected ? 'reconnecting' : 'connecting';
    return this.stalled ? 'reconnecting' : 'connected';
  }

  get hasLink(): boolean {
    return !!this.link && this.link.state !== 'closed';
  }

  attach(link: Transport): void {
    if (this.disposed) {
      link.close();
      return;
    }
    this.detach();
    this.link = link;
    this.lastHeard = this.clock.now();
    this.stalled = false;
    this.lost = false;
    this.unlink = [
      link.onMessage((msg) => this.onMessage(msg)),
      link.onState((state) => this.onLinkState(state)),
    ];
    if (link.state === 'open') this.dispatch({ type: 'link-up' });
    else this.changed();
  }

  detach(): void {
    const link = this.link;
    if (!link) return;
    for (const off of this.unlink) off();
    this.unlink = [];
    this.link = null;
    link.close();
    if (this.session.link !== 'down') this.dispatch({ type: 'link-down' });
    else this.changed();
  }

  sendBye(): void {
    this.link?.send({ t: 'bye' });
  }

  onNotice(fn: (n: DriverNotice) => void): () => void {
    this.noticeListeners.add(fn);
    return () => this.noticeListeners.delete(fn);
  }

  subscribe(fn: (s: DriverSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  snapshot(): DriverSnapshot {
    this.cached ??= this.buildSnapshot();
    return this.cached;
  }

  submitMove(move: string): boolean {
    return this.dispatch({ type: 'move', move });
  }

  resign(): void {
    this.dispatch({ type: 'resign' });
  }

  offer(kind: OfferKind): void {
    this.dispatch({ type: 'offer', kind });
  }

  answer(kind: OfferKind, accept: boolean): void {
    this.dispatch({ type: 'answer', kind, accept });
  }

  dispose(): void {
    if (this.disposed) return;
    this.sendBye();
    this.detach();
    this.disposed = true;
    this.stopTimer();
    this.listeners.clear();
    this.noticeListeners.clear();
  }

  private buildSnapshot(): DriverSnapshot {
    const s = this.session;
    const game = s.game;
    const online: OnlineSnapshot = { status: this.status, role: s.role, code: this.code };
    if (this.rttMs !== undefined && online.status === 'connected') online.rttMs = this.rttMs;
    if (s.peerName) online.peerName = s.peerName;
    const incoming = incomingOffer(s);
    const outgoing = outgoingOffer(s);
    if (incoming) online.incomingOffer = incoming;
    if (outgoing) online.outgoingOffer = outgoing;
    if (s.error) online.error = s.error;
    return {
      startFen: INITIAL_FEN,
      moves: game ? [...game.moves] : [],
      mySides: game ? [sideOf(s.role, game)] : [],
      ...(game?.result ? { result: { ...game.result } } : {}),
      online,
    };
  }

  private dispatch(event: SessionEvent): boolean {
    if (this.disposed) return false;
    const before = this.status;
    const res = step(this.session, event, { newGameId: this.newGameId });
    this.session = res.state;
    for (const msg of res.send) this.transmit(msg);
    if ((this.session.error && FATAL.has(this.session.error.kind)) || res.notices.includes('peer-left')) this.closeLinkOnly();
    this.persist();
    this.changed();
    this.announce(before, res.notices);
    return res.ok;
  }

  private transmit(msg: WireMsg): void {
    if (!this.link) return;
    if (msg.t === 'ping') this.pingSent.set(msg.n, this.clock.now());
    this.link.send(msg);
  }

  private closeLinkOnly(): void {
    const link = this.link;
    if (!link) return;
    for (const off of this.unlink) off();
    this.unlink = [];
    this.link = null;
    this.lost = false;
    link.close();
    if (this.session.link !== 'down') this.session = step(this.session, { type: 'link-down' }, { newGameId: this.newGameId }).state;
  }

  private onMessage(msg: WireMsg): void {
    this.lastHeard = this.clock.now();
    const before = this.status;
    const wasQuiet = this.stalled || this.lost;
    this.stalled = false;
    this.lost = false;
    if (msg.t === 'pong') {
      const sent = this.pingSent.get(msg.n);
      if (sent !== undefined) {
        this.rttMs = Math.max(0, Math.round(this.clock.now() - sent));
        this.pingSent.clear();
      }
    }
    this.dispatch({ type: 'receive', msg });
    if (wasQuiet) {
      this.changed();
      this.announce(before, []);
    }
  }

  private onLinkState(state: Transport['state']): void {
    if (state === 'open') {
      this.lastHeard = this.clock.now();
      if (this.session.link === 'down') this.dispatch({ type: 'link-up' });
      else this.changed();
      return;
    }
    if (state === 'closed') {
      const before = this.status;
      for (const off of this.unlink) off();
      this.unlink = [];
      this.link = null;
      this.lost = false;
      if (this.session.link !== 'down') this.session = step(this.session, { type: 'link-down' }, { newGameId: this.newGameId }).state;
      this.changed();
      this.announce(before, []);
      return;
    }
    this.changed();
  }

  private onTimer(): void {
    const now = this.clock.now();
    const frozen = now - this.lastTimerAt > FROZEN_GAP_MS;
    this.lastTimerAt = now;
    if (this.disposed || !this.link || this.link.state === 'closed') return;
    if (frozen) {
      if (!this.lost) this.lastHeard = now;
      this.lastPingAt = 0;
    }
    const silent = now - this.lastHeard;
    if (this.link.state === 'connecting') return;
    const before = this.status;
    if (silent > GIVE_UP_AFTER_MS) {
      this.closeLinkOnly();
      this.changed();
      this.announce(before, []);
      return;
    }
    const stalled = silent > STALL_AFTER_MS;
    const lost = silent > LOST_AFTER_MS;
    if (stalled !== this.stalled || lost !== this.lost) {
      this.stalled = stalled;
      this.lost = lost;
      this.changed();
      this.announce(before, []);
    }
    if (this.clock.now() - this.lastPingAt >= PING_INTERVAL_MS) {
      this.lastPingAt = this.clock.now();
      this.dispatch({ type: 'tick' });
    }
  }

  private announce(before: ConnStatus, notices: Notice[]): void {
    const after = this.status;
    const out: DriverNotice[] = [...notices];
    if (after === 'connected') this.wasConnected = true;
    if (after === 'connected' && before !== 'connected') out.unshift('connected');
    if (after === 'disconnected' && before !== 'disconnected' && before !== 'idle') out.push('disconnected');
    for (const n of out) for (const fn of [...this.noticeListeners]) fn(n);
  }

  private persistKey(): string {
    const s = this.session;
    return JSON.stringify([s.game, s.offer ?? null, s.peerClientId ?? null, s.peerName ?? null]);
  }

  private persist(): void {
    const key = this.persistKey();
    if (key === this.lastSaved) return;
    this.lastSaved = key;
    const s = this.session;
    const record: RoomRecord = { ...this.record, game: s.game, updatedAt: this.clock.now() };
    delete record.offer;
    if (s.offer) record.offer = s.offer;
    if (s.peerClientId) record.peerClientId = s.peerClientId;
    if (s.peerName) record.peerName = s.peerName;
    this.record = record;
    this.save(record);
  }

  get roomRecord(): RoomRecord {
    return this.record;
  }

  private changed(): void {
    this.cached = null;
    if (this.listeners.size === 0) return;
    const snap = this.snapshot();
    for (const fn of [...this.listeners]) fn(snap);
  }
}
