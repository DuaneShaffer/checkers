import type { LevelSpec } from './levels.ts';
import type { AiClientApi, AiMove, AiRequest, AiResponse, GameRef, NetId } from './protocol.ts';
import { patientTimeout } from '../shared/patientTimeout.ts';

export interface WorkerLike {
  postMessage(msg: AiRequest): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<AiResponse>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

export type WorkerFactory = () => WorkerLike;

export interface AiClientOptions {
  spawn?: WorkerFactory;
  watchdogMs?: (level: LevelSpec) => number;
  startupGraceMs?: number;
  loadTimeoutMs?: number;
}

interface Waiter<T> {
  resolve(value: T): void;
  reject(err: Error): void;
}

interface PendingThink extends Waiter<AiMove> {
  timer: ReturnType<typeof setTimeout>;
}

interface PendingLoad {
  netId: string;
  url: string;
  waiters: Waiter<void>[];
}

export function spawnAiWorker(): WorkerLike {
  return new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' }) as WorkerLike;
}

export const STARTUP_GRACE_MS = 30_000;
export const LOAD_TIMEOUT_MS = 10_000;

export function defaultWatchdogMs(level: LevelSpec): number {
  return level.timeMs * 3 + 10_000;
}

export function cancelledError(message = 'AI request cancelled'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function absoluteUrl(url: string): string {
  try {
    return new URL(url, globalThis.location?.href).href;
  } catch {
    return url;
  }
}

export class AiClient implements AiClientApi {
  private readonly spawn: WorkerFactory;
  private readonly watchdogMs: (level: LevelSpec) => number;
  private readonly startupGraceMs: number;
  private readonly loadTimeoutMs: number;
  private worker: WorkerLike | null = null;
  private workerResponded = false;
  private nextReqId = 1;
  private disposed = false;
  private readonly thinks = new Map<number, PendingThink>();
  private readonly loaded = new Map<string, string>();
  private loads: PendingLoad[] = [];

  constructor(opts: AiClientOptions = {}) {
    this.spawn = opts.spawn ?? spawnAiWorker;
    this.watchdogMs = opts.watchdogMs ?? defaultWatchdogMs;
    this.startupGraceMs = opts.startupGraceMs ?? STARTUP_GRACE_MS;
    this.loadTimeoutMs = opts.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
  }

  loadNet(netId: string, url: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('AI client is disposed'));
    const abs = absoluteUrl(url);
    if (this.loaded.get(netId) === abs && !this.loads.some((l) => l.netId === netId)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cancelTimer = patientTimeout(this.loadTimeoutMs, () => this.abandonLoad(waiter, netId));
      const waiter: Waiter<void> = {
        resolve: () => {
          cancelTimer();
          resolve();
        },
        reject: (err) => {
          cancelTimer();
          reject(err);
        },
      };
      const inFlight = this.loads.find((l) => l.netId === netId && l.url === abs);
      if (inFlight) {
        inFlight.waiters.push(waiter);
        return;
      }
      try {
        this.sendLoad({ netId, url: abs, waiters: [waiter] });
      } catch (err) {
        waiter.reject(asError(err));
      }
    });
  }

  think(game: GameRef, netId: NetId, level: LevelSpec, seed?: number): Promise<AiMove> {
    if (this.disposed) return Promise.reject(new Error('AI client is disposed'));
    return new Promise<AiMove>((resolve, reject) => {
      const reqId = this.nextReqId++;
      const msg: AiRequest = { type: 'think', reqId, netId, startFen: game.startFen, moves: [...game.moves], level: { ...level } };
      if (seed !== undefined) msg.seed = seed;
      try {
        const worker = this.ensureWorker();
        const limit = this.watchdogMs(level) + (this.workerResponded ? 0 : this.startupGraceMs);
        this.thinks.set(reqId, { resolve, reject, timer: setTimeout(() => this.timeOut(reqId), limit) });
        worker.postMessage(msg);
      } catch (err) {
        this.settleThink(reqId);
        reject(asError(err));
      }
    });
  }

  cancel(): void {
    if (this.disposed || !this.worker) return;
    this.restart(cancelledError());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.killWorker();
    const err = new Error('AI client is disposed');
    this.rejectThinks(err);
    for (const load of this.loads) load.waiters.forEach((w) => w.reject(err));
    this.loads = [];
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.spawn();
    worker.onmessage = (e) => {
      if (this.worker !== worker) return;
      this.workerResponded = true;
      this.receive(e.data);
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      if (this.worker === worker) this.crash(new Error(`AI worker failed: ${e.message || 'unknown error'}`));
    };
    this.worker = worker;
    this.workerResponded = false;
    const pending = this.loads;
    this.loads = [];
    for (const [netId, url] of this.loaded) {
      if (!pending.some((l) => l.netId === netId)) this.sendLoad({ netId, url, waiters: [] });
    }
    for (const load of pending) this.sendLoad(load);
    return worker;
  }

  private sendLoad(load: PendingLoad): void {
    const worker = this.ensureWorker();
    this.loads.push(load);
    worker.postMessage({ type: 'loadNet', netId: load.netId, url: load.url });
  }

  private receive(msg: AiResponse): void {
    switch (msg.type) {
      case 'netLoaded': {
        const load = this.takeLoad(msg.netId);
        if (!load) return;
        this.loaded.set(load.netId, load.url);
        load.waiters.forEach((w) => w.resolve());
        return;
      }
      case 'move': {
        const { type: _type, reqId, ...move } = msg;
        this.settleThink(reqId)?.resolve(move);
        return;
      }
      case 'error': {
        const err = new Error(msg.message);
        if (msg.reqId !== undefined) {
          this.settleThink(msg.reqId)?.reject(err);
          return;
        }
        const load = this.loads.shift();
        if (!load) return;
        if (this.loaded.get(load.netId) === load.url) this.loaded.delete(load.netId);
        load.waiters.forEach((w) => w.reject(err));
        return;
      }
    }
  }

  private takeLoad(netId: string): PendingLoad | undefined {
    const at = this.loads.findIndex((l) => l.netId === netId);
    return at < 0 ? undefined : this.loads.splice(at, 1)[0];
  }

  private abandonLoad(waiter: Waiter<void>, netId: string): void {
    for (const load of this.loads) {
      const at = load.waiters.indexOf(waiter);
      if (at < 0) continue;
      load.waiters.splice(at, 1);
      waiter.reject(new Error(`Network ${netId} took too long to load`));
      return;
    }
  }

  private settleThink(reqId: number): PendingThink | undefined {
    const pending = this.thinks.get(reqId);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.thinks.delete(reqId);
    return pending;
  }

  private rejectThinks(err: Error): void {
    for (const reqId of [...this.thinks.keys()]) this.settleThink(reqId)?.reject(err);
  }

  private timeOut(reqId: number): void {
    if (!this.thinks.has(reqId)) return;
    this.settleThink(reqId)?.reject(new Error('AI took too long to respond'));
    this.restart(cancelledError());
  }

  private restart(err: Error): void {
    this.killWorker();
    this.rejectThinks(err);
    if (!this.loads.some((l) => l.waiters.length > 0)) return;
    try {
      this.ensureWorker();
    } catch (spawnErr) {
      this.crash(asError(spawnErr));
    }
  }

  private crash(err: Error): void {
    this.killWorker();
    this.rejectThinks(err);
    for (const load of this.loads) load.waiters.forEach((w) => w.reject(err));
    this.loads = [];
  }

  private killWorker(): void {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  }
}

export function createAiClient(opts?: AiClientOptions): AiClient {
  return new AiClient(opts);
}
