import type { WireMsg } from './protocol.ts';

export type LinkState = 'connecting' | 'open' | 'reconnecting' | 'closed';
export type CloseReason = 'local' | 'remote' | 'failed';

export interface Transport {
  readonly state: LinkState;
  readonly closeReason?: CloseReason;
  send(msg: WireMsg): boolean;
  onMessage(fn: (msg: WireMsg) => void): () => void;
  onState(fn: (state: LinkState) => void): () => void;
  close(): void;
}

export class Listeners<T> {
  private readonly fns = new Set<(value: T) => void>();

  add(fn: (value: T) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }

  emit(value: T): void {
    for (const fn of [...this.fns]) fn(value);
  }

  clear(): void {
    this.fns.clear();
  }
}
