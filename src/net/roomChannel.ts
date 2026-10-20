export type RoomChannelMsg =
  | { type: 'answer'; id: string; blob: string }
  | { type: 'answer-ack'; id: string; ok: boolean }
  | { type: 'takeover'; id: string };

export interface RoomChannel {
  post(msg: RoomChannelMsg): void;
  on(fn: (msg: RoomChannelMsg) => void): () => void;
  close(): void;
}

const isStr = (v: unknown, max = 4000): v is string => typeof v === 'string' && v.length <= max;

function parse(data: unknown): RoomChannelMsg | null {
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  if (!isStr(m.id, 64)) return null;
  if (m.type === 'answer' && isStr(m.blob)) return { type: 'answer', id: m.id, blob: m.blob };
  if (m.type === 'answer-ack' && typeof m.ok === 'boolean') return { type: 'answer-ack', id: m.id, ok: m.ok };
  if (m.type === 'takeover') return { type: 'takeover', id: m.id };
  return null;
}

export function channelName(code: string): string {
  return `checkers:rtc:${code}`;
}

export function openRoomChannel(code: string): RoomChannel {
  let bc: BroadcastChannel | null = null;
  try {
    bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel(channelName(code)) : null;
  } catch {
    bc = null;
  }
  const listeners = new Set<(msg: RoomChannelMsg) => void>();
  if (bc) {
    bc.onmessage = (e) => {
      const msg = parse(e.data);
      if (msg) for (const fn of [...listeners]) fn(msg);
    };
  }
  return {
    post(msg) {
      try {
        bc?.postMessage(msg);
      } catch {
        // channel closed
      }
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      listeners.clear();
      bc?.close();
      bc = null;
    },
  };
}

export function messageId(): string {
  return Math.random().toString(36).slice(2, 12);
}

export function deliverAnswerToWaitingTab(code: string, blob: string, timeoutMs = 1500): Promise<boolean | null> {
  const channel = openRoomChannel(code);
  const id = messageId();
  return new Promise((resolve) => {
    const finish = (value: boolean | null) => {
      clearTimeout(timer);
      channel.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    channel.on((msg) => {
      if (msg.type === 'answer-ack' && msg.id === id) finish(msg.ok);
    });
    channel.post({ type: 'answer', id, blob });
  });
}
