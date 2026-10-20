import { Worker } from 'node:worker_threads';
import { TaskHandler } from './selfplay-worker.ts';
import type { TaskEnvelope, TaskReply, WorkerRequest, WorkerResult } from './selfplay-worker.ts';

const WORKER_URL = new URL('./selfplay-worker.ts', import.meta.url);
const MAX_ATTEMPTS = 3;
const STARTUP_TIMEOUT_MS = 30_000;

export interface Pool {
  readonly size: number;
  readonly mode: 'threads' | 'inline';
  broadcast(req: WorkerRequest): Promise<void>;
  run<T extends WorkerResult>(tasks: readonly WorkerRequest[], onDone?: (index: number) => void): Promise<T[]>;
  close(): Promise<void>;
}

interface Pending {
  index: number;
  req: WorkerRequest;
  attempts: number;
}

interface Slot {
  worker: Worker;
  busy: Pending | null;
  envelopeId: number;
}

type ExecArgv = string[] | undefined;

function spawn(execArgv: ExecArgv): Worker {
  return new Worker(WORKER_URL, execArgv ? { execArgv } : {});
}

function ping(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker did not answer ping')), STARTUP_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
    };
    const onMessage = (reply: TaskReply): void => {
      if (reply.id !== -1) return;
      cleanup();
      resolve();
    };
    const onError = (e: Error): void => {
      cleanup();
      reject(e);
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.postMessage({ id: -1, req: { type: 'ping' } } satisfies TaskEnvelope);
  });
}

/** Node 24 strips types in worker threads by default; older flags are tried before giving up on threads. */
const EXEC_ARGV_CANDIDATES: ExecArgv[] = [undefined, ['--experimental-strip-types']];

async function probeExecArgv(): Promise<ExecArgv | null> {
  for (const execArgv of EXEC_ARGV_CANDIDATES) {
    const worker = spawn(execArgv);
    try {
      await ping(worker);
      return execArgv;
    } catch {
      // try the next strategy
    } finally {
      await worker.terminate();
    }
  }
  return null;
}

export class ThreadPool implements Pool {
  readonly size: number;
  readonly mode = 'threads' as const;
  private readonly execArgv: ExecArgv;
  private readonly slots: Slot[] = [];
  private broadcasts: WorkerRequest[] = [];
  private queue: Pending[] = [];
  private results: WorkerResult[] = [];
  private remaining = 0;
  private onDone: ((index: number) => void) | undefined;
  private settle: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private nextEnvelope = 0;
  private closed = false;

  constructor(size: number, execArgv: ExecArgv) {
    this.size = size;
    this.execArgv = execArgv;
    for (let i = 0; i < size; i++) this.slots.push(this.createSlot());
  }

  private createSlot(): Slot {
    const slot: Slot = { worker: spawn(this.execArgv), busy: null, envelopeId: -1 };
    this.attach(slot);
    for (const req of this.broadcasts) slot.worker.postMessage({ id: -2, req } satisfies TaskEnvelope);
    return slot;
  }

  private attach(slot: Slot): void {
    slot.worker.on('message', (reply: TaskReply) => this.onReply(slot, reply));
    slot.worker.on('error', (e: Error) => this.onCrash(slot, e));
    slot.worker.on('exit', (code: number) => {
      if (!this.closed && code !== 0) this.onCrash(slot, new Error(`worker exited with code ${code}`));
    });
  }

  async broadcast(req: WorkerRequest): Promise<void> {
    this.broadcasts = req.type === 'nets' ? [...this.broadcasts.filter((b) => b.type !== 'nets'), req] : [...this.broadcasts, req];
    for (const slot of this.slots) slot.worker.postMessage({ id: -2, req } satisfies TaskEnvelope);
  }

  run<T extends WorkerResult>(tasks: readonly WorkerRequest[], onDone?: (index: number) => void): Promise<T[]> {
    if (this.settle) throw new Error('ThreadPool.run is already in progress');
    if (tasks.length === 0) return Promise.resolve([]);
    this.queue = tasks.map((req, index) => ({ index, req, attempts: 0 }));
    this.results = new Array(tasks.length).fill(null);
    this.remaining = tasks.length;
    this.onDone = onDone;
    return new Promise<T[]>((resolve, reject) => {
      this.settle = {
        resolve: () => resolve(this.results as T[]),
        reject,
      };
      for (const slot of this.slots) this.dispatch(slot);
    });
  }

  private dispatch(slot: Slot): void {
    if (slot.busy || this.queue.length === 0) return;
    const task = this.queue.shift()!;
    task.attempts++;
    slot.busy = task;
    slot.envelopeId = this.nextEnvelope++;
    slot.worker.postMessage({ id: slot.envelopeId, req: task.req } satisfies TaskEnvelope);
  }

  private onReply(slot: Slot, reply: TaskReply): void {
    if (reply.id < 0) {
      if (!reply.ok) this.fail(new Error(`worker setup failed: ${reply.error}`));
      return;
    }
    const task = slot.busy;
    if (!task || reply.id !== slot.envelopeId) return;
    slot.busy = null;
    if (!reply.ok) {
      this.fail(new Error(`task ${task.index} (${task.req.type}) failed: ${reply.error}`));
      return;
    }
    this.results[task.index] = reply.result;
    this.remaining--;
    this.onDone?.(task.index);
    if (this.remaining === 0) {
      const settle = this.settle;
      this.settle = null;
      settle?.resolve();
      return;
    }
    this.dispatch(slot);
  }

  private onCrash(slot: Slot, error: Error): void {
    const at = this.slots.indexOf(slot);
    if (at < 0 || this.closed) return;
    const task = slot.busy;
    slot.busy = null;
    void slot.worker.terminate();
    const replacement = this.createSlot();
    this.slots[at] = replacement;
    if (task) {
      if (task.attempts >= MAX_ATTEMPTS) {
        this.fail(new Error(`task ${task.index} crashed ${task.attempts} times: ${error.message}`));
        return;
      }
      process.stderr.write(`worker crashed (${error.message}); retrying task ${task.index}\n`);
      this.queue.unshift(task);
    }
    this.dispatch(replacement);
  }

  private fail(error: Error): void {
    const settle = this.settle;
    this.settle = null;
    this.queue = [];
    settle?.reject(error);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
  }
}

export class InlinePool implements Pool {
  readonly size = 1;
  readonly mode = 'inline' as const;
  private readonly handler = new TaskHandler();

  async broadcast(req: WorkerRequest): Promise<void> {
    this.handler.handle(req);
  }

  async run<T extends WorkerResult>(tasks: readonly WorkerRequest[], onDone?: (index: number) => void): Promise<T[]> {
    const results: T[] = [];
    for (let i = 0; i < tasks.length; i++) {
      results.push(structuredClone(this.handler.handle(tasks[i])) as T);
      onDone?.(i);
      await new Promise((r) => setImmediate(r));
    }
    return results;
  }

  async close(): Promise<void> {}
}

export async function createPool(size: number): Promise<Pool> {
  if (size <= 0) return new InlinePool();
  const execArgv = await probeExecArgv();
  if (execArgv === null) {
    process.stderr.write('worker_threads could not load TypeScript; running self-play inline on the main thread\n');
    return new InlinePool();
  }
  return new ThreadPool(size, execArgv);
}
