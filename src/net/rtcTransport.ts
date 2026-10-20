import type { WireMsg } from './protocol.ts';
import { Listeners } from './transport.ts';
import type { CloseReason, LinkState, Transport } from './transport.ts';
import { decodeWire, encodeWire } from './wire.ts';

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478', 'stun:stun1.l.google.com:19302'] },
];
export const GATHER_CAP_MS = 3000;
const GATHER_QUIET_MS = 700;
const RESTART_DELAY_MS = 1500;
const RESTART_COOLDOWN_MS = 8000;
export const HANDSHAKE_DEADLINE_MS = 25_000;
const MAX_INBOUND_PER_SECOND = 100;

export interface RtcOptions {
  iceServers?: RTCIceServer[];
  gatherCapMs?: number;
}

export class RtcError extends Error {
  readonly kind: 'unsupported' | 'bad-sdp' | 'state';

  constructor(kind: 'unsupported' | 'bad-sdp' | 'state', message: string) {
    super(message);
    this.name = 'RtcError';
    this.kind = kind;
  }
}

export function webRtcSupported(): boolean {
  return typeof RTCPeerConnection === 'function';
}

export function waitForGathering(pc: RTCPeerConnection, capMs = GATHER_CAP_MS): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let sawReflexive = false;
    const done = () => {
      clearTimeout(cap);
      clearTimeout(quiet);
      pc.removeEventListener('icecandidate', onCandidate);
      pc.removeEventListener('icegatheringstatechange', onState);
      resolve();
    };
    const onCandidate = (e: RTCPeerConnectionIceEvent) => {
      if (!e.candidate) return done();
      if (/ typ srflx /.test(e.candidate.candidate)) sawReflexive = true;
      if (sawReflexive) {
        clearTimeout(quiet);
        quiet = setTimeout(done, GATHER_QUIET_MS);
      }
    };
    const onState = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const cap = setTimeout(done, capMs);
    pc.addEventListener('icecandidate', onCandidate);
    pc.addEventListener('icegatheringstatechange', onState);
  });
}

export class RtcLink implements Transport {
  state: LinkState = 'connecting';
  closeReason?: CloseReason;
  readonly isOfferer: boolean;
  private readonly pc: RTCPeerConnection;
  private readonly channel: RTCDataChannel;
  private readonly gatherCapMs: number;
  private readonly messages = new Listeners<WireMsg>();
  private readonly states = new Listeners<LinkState>();
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private iceReached = false;
  private lastRestart = 0;
  private inboundWindow = 0;
  private inboundCount = 0;
  private unclaimed: WireMsg[] | null = [];

  private constructor(isOfferer: boolean, opts: RtcOptions) {
    if (!webRtcSupported()) throw new RtcError('unsupported', 'This browser does not support WebRTC');
    this.isOfferer = isOfferer;
    this.gatherCapMs = opts.gatherCapMs ?? GATHER_CAP_MS;
    this.pc = new RTCPeerConnection({ iceServers: opts.iceServers ?? ICE_SERVERS });
    this.channel = this.pc.createDataChannel('game', { negotiated: true, id: 0, ordered: true });
    this.channel.onopen = () => this.setState('open');
    this.channel.onclose = () => this.shutdown(this.closeReason ?? 'remote');
    this.channel.onmessage = (e) => this.receive(e.data);
    this.pc.oniceconnectionstatechange = () => this.onIceState();
    this.pc.onconnectionstatechange = () => {
      const conn = this.pc.connectionState;
      if (conn === 'closed') this.shutdown(this.closeReason ?? 'remote');
      else if (conn === 'failed' && this.state === 'connecting') this.shutdown('failed');
    };
  }

  static async offer(opts: RtcOptions = {}): Promise<{ link: RtcLink; sdp: string }> {
    const link = new RtcLink(true, opts);
    try {
      await link.pc.setLocalDescription(await link.pc.createOffer());
      return { link, sdp: await link.localSdp() };
    } catch (e) {
      link.close();
      throw e;
    }
  }

  static async answer(offerSdp: string, opts: RtcOptions = {}): Promise<{ link: RtcLink; sdp: string }> {
    const link = new RtcLink(false, opts);
    try {
      await link.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    } catch {
      link.close();
      throw new RtcError('bad-sdp', 'The invite link could not be used');
    }
    try {
      await link.pc.setLocalDescription(await link.pc.createAnswer());
      return { link, sdp: await link.localSdp() };
    } catch (e) {
      link.close();
      throw e;
    }
  }

  get reachedPeer(): boolean {
    return this.iceReached;
  }

  get awaitingAnswer(): boolean {
    return this.isOfferer && this.pc.signalingState === 'have-local-offer' && this.state !== 'closed';
  }

  async acceptAnswer(sdp: string): Promise<void> {
    if (!this.awaitingAnswer) throw new RtcError('state', 'This invite has already been answered');
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp });
    } catch {
      throw new RtcError('bad-sdp', 'The reply could not be used');
    }
  }

  send(msg: WireMsg): boolean {
    if (this.channel.readyState !== 'open') return false;
    try {
      this.channel.send(encodeWire(msg));
      return true;
    } catch {
      return false;
    }
  }

  onMessage(fn: (msg: WireMsg) => void): () => void {
    const off = this.messages.add(fn);
    const queued = this.unclaimed;
    this.unclaimed = null;
    if (queued?.length) queueMicrotask(() => queued.forEach((m) => this.messages.emit(m)));
    return off;
  }

  onState(fn: (state: LinkState) => void): () => void {
    return this.states.add(fn);
  }

  close(): void {
    this.shutdown('local');
  }

  private async localSdp(): Promise<string> {
    await waitForGathering(this.pc, this.gatherCapMs);
    const sdp = this.pc.localDescription?.sdp;
    if (!sdp) throw new RtcError('state', 'No local description');
    return sdp;
  }

  private setState(state: LinkState): void {
    if (this.state === state || this.state === 'closed') return;
    if (state !== 'connecting') clearTimeout(this.handshakeTimer);
    this.state = state;
    this.states.emit(state);
  }

  private shutdown(reason: CloseReason): void {
    if (this.state === 'closed') return;
    this.closeReason = reason;
    clearTimeout(this.restartTimer);
    clearTimeout(this.handshakeTimer);
    this.channel.onopen = this.channel.onclose = this.channel.onmessage = null;
    this.pc.oniceconnectionstatechange = this.pc.onconnectionstatechange = null;
    try {
      this.channel.close();
      this.pc.close();
    } catch {
      // already closed
    }
    this.setState('closed');
    this.messages.clear();
    this.states.clear();
  }

  private receive(data: unknown): void {
    const now = Date.now();
    if (now - this.inboundWindow > 1000) {
      this.inboundWindow = now;
      this.inboundCount = 0;
    }
    if (++this.inboundCount > MAX_INBOUND_PER_SECOND) return;
    const msg = decodeWire(data);
    if (!msg) return;
    if (msg.t === 'ice-restart') {
      void this.onRestartMessage(msg).catch(() => {});
      return;
    }
    if (this.unclaimed) {
      if (this.unclaimed.length < MAX_INBOUND_PER_SECOND) this.unclaimed.push(msg);
      return;
    }
    this.messages.emit(msg);
  }

  private onIceState(): void {
    const ice = this.pc.iceConnectionState;
    if (ice === 'connected' || ice === 'completed') {
      clearTimeout(this.restartTimer);
      if (this.channel.readyState === 'open') this.setState('open');
      else if (this.state === 'connecting') this.awaitHandshake();
      return;
    }
    if (ice === 'failed' && this.state === 'connecting') {
      this.shutdown('failed');
      return;
    }
    if ((ice === 'disconnected' || ice === 'failed') && this.state !== 'connecting') {
      this.setState('reconnecting');
      if (this.isOfferer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => void this.restartIce().catch(() => {}), ice === 'failed' ? 0 : RESTART_DELAY_MS);
      }
    }
  }

  // ICE can succeed against an offer whose DTLS session already belongs to another
  // peer (a reused invite); the handshake then never finishes and the browser never fails it.
  private awaitHandshake(): void {
    if (this.iceReached) return;
    this.iceReached = true;
    this.handshakeTimer = setTimeout(() => {
      const finishing = this.pc.connectionState === 'connected' || this.channel.readyState === 'open';
      if (this.state === 'connecting' && !finishing) this.shutdown('failed');
    }, HANDSHAKE_DEADLINE_MS);
  }

  private async restartIce(): Promise<void> {
    const ice = this.pc.iceConnectionState;
    const now = Date.now();
    if (this.state === 'closed' || (ice !== 'disconnected' && ice !== 'failed')) return;
    if (this.pc.signalingState !== 'stable' || now - this.lastRestart < RESTART_COOLDOWN_MS) return;
    this.lastRestart = now;
    await this.pc.setLocalDescription(await this.pc.createOffer({ iceRestart: true }));
    const sdp = await this.localSdp();
    this.send({ t: 'ice-restart', kind: 'offer', sdp });
  }

  private async onRestartMessage(msg: Extract<WireMsg, { t: 'ice-restart' }>): Promise<void> {
    if (msg.kind === 'offer' && !this.isOfferer && this.pc.signalingState === 'stable') {
      await this.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      this.send({ t: 'ice-restart', kind: 'answer', sdp: await this.localSdp() });
    } else if (msg.kind === 'answer' && this.isOfferer && this.pc.signalingState === 'have-local-offer') {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    }
  }
}
