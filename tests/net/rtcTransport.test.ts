import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WireMsg } from '../../src/net/protocol.ts';
import { RtcLink } from '../../src/net/rtcTransport.ts';

class FakeChannel {
  readyState: RTCDataChannelState = 'connecting';
  peer: FakeChannel | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;

  send(data: string): void {
    if (this.readyState !== 'open') throw new Error('not open');
    const peer = this.peer;
    queueMicrotask(() => peer?.onmessage?.({ data }));
  }

  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
    this.peer?.close();
  }
}

class FakePC extends EventTarget {
  static created: FakePC[] = [];
  iceGatheringState: RTCIceGatheringState = 'complete';
  iceConnectionState: RTCIceConnectionState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  channel!: FakeChannel;
  log: string[] = [];
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  private n = 0;

  constructor() {
    super();
    FakePC.created.push(this);
  }

  createDataChannel(): FakeChannel {
    this.channel = new FakeChannel();
    return this.channel;
  }

  async createOffer(opts?: { iceRestart?: boolean }) {
    this.log.push(opts?.iceRestart ? 'createOffer(restart)' : 'createOffer');
    return { type: 'offer', sdp: `offer-${++this.n}` };
  }

  async createAnswer() {
    this.log.push('createAnswer');
    return { type: 'answer', sdp: `answer-${++this.n}` };
  }

  async setLocalDescription(d: { type: string; sdp: string }) {
    this.log.push(`local:${d.type}`);
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }

  async setRemoteDescription(d: { type: string; sdp: string }) {
    if (d.sdp === 'garbage') throw new Error('bad sdp');
    this.log.push(`remote:${d.type}:${d.sdp}`);
    this.remoteDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }

  setIce(state: RTCIceConnectionState): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }

  close(): void {
    this.connectionState = 'closed';
  }
}

async function pair() {
  const host = await RtcLink.offer();
  const guest = await RtcLink.answer(host.sdp);
  await host.link.acceptAnswer(guest.sdp);
  const [hpc, gpc] = FakePC.created.slice(-2);
  hpc.channel.peer = gpc.channel;
  gpc.channel.peer = hpc.channel;
  return { host: host.link, guest: guest.link, hpc, gpc };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  FakePC.created = [];
  (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePC;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
});

describe('RtcLink', () => {
  it('performs a non-trickle offer/answer and opens', async () => {
    const { host, guest, hpc, gpc } = await pair();
    expect(hpc.log).toEqual(['createOffer', 'local:offer', 'remote:answer:answer-1']);
    expect(gpc.log).toEqual(['remote:offer:offer-1', 'createAnswer', 'local:answer']);
    const states: string[] = [];
    host.onState((s) => states.push(s));
    hpc.channel.open();
    gpc.channel.open();
    expect(host.state).toBe('open');
    expect(guest.state).toBe('open');
    expect(states).toEqual(['open']);
    expect(host.awaitingAnswer).toBe(false);
    await expect(host.acceptAnswer('answer-x')).rejects.toThrow();
  });

  it('rejects unusable SDP', async () => {
    await expect(RtcLink.answer('garbage')).rejects.toMatchObject({ kind: 'bad-sdp' });
  });

  it('holds messages that arrive before anyone listens', async () => {
    const { host, guest, hpc, gpc } = await pair();
    hpc.channel.open();
    gpc.channel.open();
    host.send({ t: 'hello', proto: 1, clientId: 'abc', role: 'host' });
    host.send({ t: 'bye' });
    await flush();
    const got: WireMsg[] = [];
    guest.onMessage((m) => got.push(m));
    await flush();
    expect(got.map((m) => m.t)).toEqual(['hello', 'bye']);
  });

  it('drops malformed messages', async () => {
    const { guest, hpc, gpc } = await pair();
    hpc.channel.open();
    gpc.channel.open();
    const got: WireMsg[] = [];
    guest.onMessage((m) => got.push(m));
    hpc.channel.send('{"t":"move","ply":-1}');
    hpc.channel.send('not json');
    await flush();
    expect(got).toEqual([]);
  });

  it('restarts ICE over the open channel when the connection degrades', async () => {
    const { host, guest, hpc, gpc } = await pair();
    hpc.channel.open();
    gpc.channel.open();
    host.onMessage(() => {});
    guest.onMessage(() => {});
    vi.useFakeTimers();
    hpc.setIce('disconnected');
    expect(host.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1600);
    vi.useRealTimers();
    await flush();
    await flush();
    expect(hpc.log.slice(3)).toEqual(['createOffer(restart)', 'local:offer', 'remote:answer:answer-2']);
    expect(gpc.log.slice(3)).toEqual(['remote:offer:offer-2', 'createAnswer', 'local:answer']);
    hpc.setIce('connected');
    expect(host.state).toBe('open');
  });

  it('only the offerer starts an ICE restart', async () => {
    const { guest, hpc, gpc } = await pair();
    hpc.channel.open();
    gpc.channel.open();
    vi.useFakeTimers();
    gpc.setIce('disconnected');
    await vi.advanceTimersByTimeAsync(5000);
    expect(guest.state).toBe('reconnecting');
    expect(gpc.log).toEqual(['remote:offer:offer-1', 'createAnswer', 'local:answer']);
  });

  it('closes when the channel closes and stops delivering', async () => {
    const { host, guest, hpc, gpc } = await pair();
    hpc.channel.open();
    gpc.channel.open();
    const states: string[] = [];
    guest.onState((s) => states.push(s));
    host.close();
    expect(host.state).toBe('closed');
    expect(host.closeReason).toBe('local');
    expect(guest.state).toBe('closed');
    expect(guest.closeReason).toBe('remote');
    expect(states).toEqual(['closed']);
    expect(host.send({ t: 'bye' })).toBe(false);
  });
});
