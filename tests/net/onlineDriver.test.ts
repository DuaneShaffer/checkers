import { describe, expect, it } from 'vitest';
import { GIVE_UP_AFTER_MS, LOST_AFTER_MS, OnlineDriver } from '../../src/net/onlineDriver.ts';
import type { DriverNotice } from '../../src/net/onlineDriver.ts';
import type { RoomRecord } from '../../src/net/roomStore.ts';
import { LoopbackNetwork, NO_FAULTS, Scheduler } from '../support/loopbackTransport.ts';

const record = (role: 'host' | 'guest', extra: Partial<RoomRecord> = {}): RoomRecord => ({
  v: 1, code: 'ABCDE12345', role, clientId: `${role}-id`, name: role === 'host' ? 'Hana' : 'Gus', firstHostSide: 1, game: null, createdAt: 0, updatedAt: 0, ...extra,
});

function setup() {
  const scheduler = new Scheduler();
  const net = new LoopbackNetwork(scheduler, () => 0.5, { ...NO_FAULTS, minDelay: 20, maxDelay: 20 });
  const saved: Record<string, RoomRecord> = {};
  const clock = scheduler.clock();
  let n = 0;
  const make = (r: RoomRecord) => new OnlineDriver({ record: r, clock, save: (x) => (saved[x.role] = x), newGameId: (seq) => `${seq}.g${n++}` });
  const host = make(record('host'));
  const guest = make(record('guest'));
  const [a, b] = net.connect(10);
  host.attach(a);
  guest.attach(b);
  return { scheduler, net, saved, host, guest, a, b, make };
}

describe('OnlineDriver', () => {
  it('connects, starts a game and exposes online snapshot fields', () => {
    const { scheduler, host, guest } = setup();
    expect(host.snapshot().online!.status).toBe('connecting');
    scheduler.runUntil(200);
    const hs = host.snapshot();
    const gs = guest.snapshot();
    expect(hs.online).toMatchObject({ status: 'connected', role: 'host', code: 'ABCDE12345', peerName: 'Gus' });
    expect(gs.online).toMatchObject({ status: 'connected', role: 'guest', peerName: 'Hana' });
    expect(hs.mySides).toEqual([1]);
    expect(gs.mySides).toEqual([0]);
    expect(hs.moves).toEqual([]);
    expect(gs.startFen).toBe(hs.startFen);
  });

  it('plays moves both ways, persists, and measures rtt', () => {
    const { scheduler, host, guest, saved } = setup();
    scheduler.runUntil(200);
    expect(host.submitMove('11-15')).toBe(false);
    expect(guest.submitMove('11-15')).toBe(true);
    scheduler.runUntil(400);
    expect(host.submitMove('23-19')).toBe(true);
    scheduler.runUntil(4000);
    expect(guest.snapshot().moves).toEqual(['11-15', '23-19']);
    expect(saved.guest.game!.moves).toEqual(['11-15', '23-19']);
    expect(saved.host.peerClientId).toBe('guest-id');
    expect(host.snapshot().online!.rttMs).toBe(40);
  });

  it('notifies subscribers with fresh snapshots', () => {
    const { scheduler, host, guest } = setup();
    const seen: string[][] = [];
    host.subscribe((s) => seen.push(s.moves));
    scheduler.runUntil(200);
    guest.submitMove('9-13');
    scheduler.runUntil(400);
    expect(seen.at(-1)).toEqual(['9-13']);
    expect(host.snapshot()).toBe(host.snapshot());
  });

  it('reports a lost peer after silence and announces it', () => {
    const { scheduler, net, host } = setup();
    const notices: DriverNotice[] = [];
    host.onNotice((n) => notices.push(n));
    scheduler.runUntil(200);
    net.faults = { ...NO_FAULTS, drop: 1 };
    scheduler.runUntil(200 + 7000);
    expect(host.status).toBe('reconnecting');
    scheduler.runUntil(200 + LOST_AFTER_MS + 2000);
    expect(host.status).toBe('disconnected');
    expect(host.hasLink).toBe(true);
    expect(notices).toEqual(['connected', 'peer-joined', 'game-started', 'disconnected']);
    scheduler.runUntil(200 + GIVE_UP_AFTER_MS + 2000);
    expect(host.status).toBe('disconnected');
    expect(host.hasLink).toBe(false);
    expect(notices).toEqual(['connected', 'peer-joined', 'game-started', 'disconnected']);
  });

  it('recovers on the same link after a long outage without a new handshake', () => {
    const { scheduler, net, host, guest, a, b } = setup();
    const notices: DriverNotice[] = [];
    host.onNotice((n) => notices.push(n));
    scheduler.runUntil(200);
    guest.submitMove('11-15');
    scheduler.runUntil(400);
    net.faults = { ...NO_FAULTS, drop: 1 };
    host.submitMove('23-19');
    scheduler.runUntil(400 + LOST_AFTER_MS + 1000);
    expect(host.status).toBe('disconnected');
    expect(guest.status).toBe('disconnected');
    net.faults = { ...NO_FAULTS, minDelay: 20, maxDelay: 20 };
    scheduler.runUntil(400 + LOST_AFTER_MS + 8000);
    expect(host.status).toBe('connected');
    expect(guest.status).toBe('connected');
    expect(a.state).toBe('open');
    expect(b.state).toBe('open');
    expect(notices.slice(-2)).toEqual(['disconnected', 'connected']);
    expect(guest.snapshot().moves).toEqual(['11-15', '23-19']);
    expect(guest.submitMove('8-11')).toBe(true);
    scheduler.runUntil(400 + LOST_AFTER_MS + 9000);
    expect(host.snapshot().moves).toEqual(['11-15', '23-19', '8-11']);
  });

  it('marks the peer as gone when the link closes and resumes on a new link', () => {
    const { scheduler, net, host, guest, a } = setup();
    scheduler.runUntil(200);
    guest.submitMove('11-15');
    scheduler.runUntil(300);
    a.close();
    expect(host.status).toBe('disconnected');
    expect(guest.status).toBe('disconnected');
    expect(host.submitMove('23-19')).toBe(true);
    const [a2, b2] = net.connect(10);
    host.attach(a2);
    guest.attach(b2);
    scheduler.runUntil(600);
    expect(guest.snapshot().moves).toEqual(['11-15', '23-19']);
    expect(guest.status).toBe('connected');
  });

  it('rebuilds from a saved record after a reload', () => {
    const { scheduler, net, host, guest, saved, make } = setup();
    scheduler.runUntil(200);
    guest.submitMove('11-15');
    scheduler.runUntil(300);
    guest.dispose();
    const reloaded = make(saved.guest);
    expect(reloaded.snapshot().moves).toEqual(['11-15']);
    expect(reloaded.status).toBe('disconnected');
    const [a2, b2] = net.connect(10);
    host.attach(a2);
    reloaded.attach(b2);
    scheduler.runUntil(600);
    expect(reloaded.status).toBe('connected');
    expect(reloaded.snapshot().online!.peerName).toBe('Hana');
  });

  it('closes the link and fails on room-full', () => {
    const { scheduler, net, host, make } = setup();
    scheduler.runUntil(200);
    const intruder = make(record('guest', { clientId: 'intruder' }));
    const [a2, b2] = net.connect(10);
    host.attach(a2);
    intruder.attach(b2);
    scheduler.runUntil(400);
    expect(intruder.status).toBe('failed');
    expect(intruder.snapshot().online!.error).toEqual({ kind: 'room-full' });
  });

  it('exposes offers in the snapshot and supports resign', () => {
    const { scheduler, host, guest } = setup();
    scheduler.runUntil(200);
    host.offer('draw');
    scheduler.runUntil(300);
    expect(host.snapshot().online!.outgoingOffer).toBe('draw');
    expect(guest.snapshot().online!.incomingOffer).toBe('draw');
    guest.answer('draw', false);
    scheduler.runUntil(400);
    expect(host.snapshot().online!.outgoingOffer).toBeUndefined();
    guest.resign();
    scheduler.runUntil(500);
    expect(host.snapshot().result).toEqual({ winner: 1, reason: 'resign' });
  });

  it('does not declare the peer lost after this tab was frozen', () => {
    const { scheduler, host } = setup();
    scheduler.runUntil(200);
    const frozenClock = host as unknown as { lastTimerAt: number };
    frozenClock.lastTimerAt -= 30_000;
    (host as unknown as { lastHeard: number }).lastHeard -= 30_000;
    scheduler.runUntil(1300);
    expect(host.status).toBe('connected');
  });

  it('treats bye as the peer leaving', () => {
    const { scheduler, host, guest } = setup();
    const notices: DriverNotice[] = [];
    scheduler.runUntil(200);
    host.onNotice((n) => notices.push(n));
    guest.sendBye();
    scheduler.runUntil(300);
    expect(host.status).toBe('disconnected');
    expect(notices).toEqual(['peer-left', 'disconnected']);
  });

  it('stops working after dispose', () => {
    const { scheduler, host, a } = setup();
    scheduler.runUntil(200);
    host.dispose();
    expect(a.state).toBe('closed');
    expect(host.submitMove('11-15')).toBe(false);
  });
});
