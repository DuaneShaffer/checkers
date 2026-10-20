import type { Clock } from '../../src/net/onlineDriver.ts';
import type { WireMsg } from '../../src/net/protocol.ts';
import { Listeners } from '../../src/net/transport.ts';
import type { CloseReason, LinkState, Transport } from '../../src/net/transport.ts';
import { decodeWire, encodeWire } from '../../src/net/wire.ts';

interface Task { at: number; seq: number; run: () => void }

export class Scheduler {
  now = 0;
  private seq = 0;
  private queue: Task[] = [];

  at(time: number, run: () => void): void {
    this.queue.push({ at: Math.max(time, this.now), seq: this.seq++, run });
  }

  after(ms: number, run: () => void): void {
    this.at(this.now + ms, run);
  }

  get pending(): number {
    return this.queue.length;
  }

  runNext(): boolean {
    if (this.queue.length === 0) return false;
    let best = 0;
    for (let i = 1; i < this.queue.length; i++) {
      const q = this.queue[i];
      const b = this.queue[best];
      if (q.at < b.at || (q.at === b.at && q.seq < b.seq)) best = i;
    }
    const [task] = this.queue.splice(best, 1);
    this.now = task.at;
    task.run();
    return true;
  }

  runUntil(time: number): void {
    for (;;) {
      const next = this.queue.reduce<Task | null>((m, q) => (!m || q.at < m.at || (q.at === m.at && q.seq < m.seq) ? q : m), null);
      if (!next || next.at > time) break;
      this.runNext();
    }
    this.now = Math.max(this.now, time);
  }

  clock(): Clock {
    return {
      now: () => this.now,
      every: (ms, fn) => {
        let active = true;
        const tick = () => {
          if (!active) return;
          fn();
          this.after(ms, tick);
        };
        this.after(ms, tick);
        return () => {
          active = false;
        };
      },
    };
  }
}

export interface Faults {
  drop: number;
  duplicate: number;
  minDelay: number;
  maxDelay: number;
}

export const NO_FAULTS: Faults = { drop: 0, duplicate: 0, minDelay: 1, maxDelay: 1 };

export class LoopbackTransport implements Transport {
  state: LinkState = 'connecting';
  closeReason?: CloseReason;
  peer: LoopbackTransport | null = null;
  sent = 0;
  private readonly messages = new Listeners<WireMsg>();
  private readonly states = new Listeners<LinkState>();
  private readonly net: LoopbackNetwork;

  constructor(net: LoopbackNetwork) {
    this.net = net;
  }

  send(msg: WireMsg): boolean {
    if (this.state !== 'open' || !this.peer) return false;
    this.sent++;
    this.net.deliver(this.peer, encodeWire(msg));
    return true;
  }

  onMessage(fn: (msg: WireMsg) => void): () => void {
    return this.messages.add(fn);
  }

  onState(fn: (state: LinkState) => void): () => void {
    return this.states.add(fn);
  }

  close(): void {
    this.shutdown('local');
    this.peer?.shutdown('remote');
  }

  setState(state: LinkState): void {
    if (this.state === state || this.state === 'closed') return;
    this.state = state;
    this.states.emit(state);
  }

  shutdown(reason: CloseReason): void {
    if (this.state === 'closed') return;
    this.closeReason = reason;
    this.setState('closed');
    this.messages.clear();
    this.states.clear();
  }

  receive(raw: string): void {
    if (this.state !== 'open') return;
    const msg = decodeWire(raw);
    if (msg) this.messages.emit(msg);
  }
}

export class LoopbackNetwork {
  readonly scheduler: Scheduler;
  faults: Faults;
  private readonly rand: () => number;
  delivered = 0;
  dropped = 0;

  constructor(scheduler: Scheduler, rand: () => number, faults: Faults = NO_FAULTS) {
    this.scheduler = scheduler;
    this.rand = rand;
    this.faults = faults;
  }

  connect(openDelay = 5): [LoopbackTransport, LoopbackTransport] {
    const a = new LoopbackTransport(this);
    const b = new LoopbackTransport(this);
    a.peer = b;
    b.peer = a;
    this.scheduler.after(openDelay, () => {
      if (a.state === 'connecting' && b.state === 'connecting') {
        a.setState('open');
        b.setState('open');
      }
    });
    return [a, b];
  }

  deliver(to: LoopbackTransport, raw: string): void {
    const { drop, duplicate, minDelay, maxDelay } = this.faults;
    if (this.rand() < drop) {
      this.dropped++;
      return;
    }
    const copies = this.rand() < duplicate ? 2 : 1;
    for (let i = 0; i < copies; i++) {
      const delay = minDelay + Math.floor(this.rand() * (maxDelay - minDelay + 1));
      this.scheduler.after(delay, () => {
        this.delivered++;
        to.receive(raw);
      });
    }
  }
}
