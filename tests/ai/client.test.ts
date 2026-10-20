import { afterEach, describe, expect, it } from 'vitest';
import { Game } from '../../src/engine/game.ts';
import { INITIAL_FEN } from '../../src/engine/position.ts';
import { mulberry32 } from '../../src/engine/rng.ts';
import { AiWorkerCore } from '../../src/ai/ai.worker.ts';
import { AiClient, type WorkerLike } from '../../src/ai/client.ts';
import type { LevelSpec } from '../../src/ai/levels.ts';
import { Network } from '../../src/ai/network.ts';
import type { AiRequest, AiResponse } from '../../src/ai/protocol.ts';
import { DEFAULT_LAYERS } from '../../src/shared/formats.ts';

const files: Record<string, ArrayBuffer> = {
  '/nets/a.bin': Network.random(DEFAULT_LAYERS, mulberry32(1), 5).toBinary(),
  '/nets/b.bin': Network.random(DEFAULT_LAYERS, mulberry32(2), 9).toBinary(),
};

const level: LevelSpec = { maxDepth: 3, timeMs: 500, temperature: 0, blunderRate: 0, threatExtension: false };
const start = { startFen: INITIAL_FEN, moves: [] as string[] };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<AiResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  silent = false;
  readonly sent: AiRequest[] = [];
  private readonly core = new AiWorkerCore({
    ttBits: 14,
    post: (msg) => setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: structuredClone(msg) } as MessageEvent<AiResponse>);
    }, 1),
    fetchBytes: async (url) => {
      await tick(5);
      const file = files[url];
      if (!file) throw new Error(`HTTP 404 for ${url}`);
      return file.slice(0);
    },
  });

  postMessage(msg: AiRequest): void {
    this.sent.push(structuredClone(msg));
    if (this.silent) return;
    setTimeout(() => {
      if (!this.terminated) void this.core.handle(structuredClone(msg));
    }, 1);
  }

  terminate(): void {
    this.terminated = true;
  }

  crash(message: string): void {
    this.onerror?.({ message, preventDefault() {} } as ErrorEvent);
  }
}

function makeClient(opts: { silent?: boolean; watchdogMs?: number; startupGraceMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const client = new AiClient({
    spawn: () => {
      const w = new FakeWorker();
      w.silent = opts.silent ?? false;
      workers.push(w);
      return w;
    },
    watchdogMs: opts.watchdogMs !== undefined ? () => opts.watchdogMs! : undefined,
    startupGraceMs: opts.startupGraceMs,
  });
  clients.push(client);
  return { client, workers };
}

const clients: AiClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((c) => c.dispose());
});

describe('AiClient', () => {
  it('spawns lazily and returns a legal move', async () => {
    const { client, workers } = makeClient();
    expect(workers.length).toBe(0);
    const reply = await client.think(start, 'heuristic', level, 1);
    expect(workers.length).toBe(1);
    expect(() => new Game().play(reply.move)).not.toThrow();
    expect(reply.depth).toBe(3);
    expect(reply.pv[0]).toBe(reply.move);
    expect(reply).not.toHaveProperty('type');
    expect(reply).not.toHaveProperty('reqId');
  });

  it('loads nets once and thinks with them', async () => {
    const { client, workers } = makeClient();
    await Promise.all([client.loadNet('a', '/nets/a.bin'), client.loadNet('a', '/nets/a.bin')]);
    await client.loadNet('a', '/nets/a.bin');
    expect(workers[0].sent.filter((m) => m.type === 'loadNet').length).toBe(1);
    const reply = await client.think({ startFen: INITIAL_FEN, moves: ['11-15'] }, 'a', level);
    expect(() => Game.fromMoves(['11-15', reply.move])).not.toThrow();
  });

  it('rejects a failed load and keeps working', async () => {
    const { client } = makeClient();
    const results = await Promise.allSettled([
      client.loadNet('x', '/nets/missing.bin'),
      client.loadNet('b', '/nets/b.bin'),
    ]);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { message: expect.stringMatching(/404/) } });
    expect(results[1]).toMatchObject({ status: 'fulfilled' });
    await expect(client.think(start, 'x', level)).rejects.toThrow(/not loaded/);
    await expect(client.think(start, 'b', level)).resolves.toHaveProperty('move');
  });

  it('cancel rejects pending thinks, respawns and re-sends loaded nets', async () => {
    const { client, workers } = makeClient();
    await client.loadNet('a', '/nets/a.bin');
    const pending = client.think(start, 'a', { ...level, maxDepth: 30, timeMs: 2000 });
    client.cancel();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers.length).toBe(2);
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].sent).toEqual([{ type: 'loadNet', netId: 'a', url: '/nets/a.bin' }]);
    const reply = await client.think(start, 'a', level);
    expect(reply.move).toMatch(/^\d+-\d+$/);
  });

  it('keeps pending loads alive across a cancel', async () => {
    const { client, workers } = makeClient();
    const load = client.loadNet('b', '/nets/b.bin');
    client.cancel();
    await expect(load).resolves.toBeUndefined();
    expect(workers[1].sent.filter((m) => m.type === 'loadNet').length).toBe(1);
  });

  it('ignores replies from a terminated worker', async () => {
    const { client, workers } = makeClient();
    const first = client.think(start, 'heuristic', level, 1);
    client.cancel();
    await expect(first).rejects.toThrow(/cancel/);
    const second = await client.think(start, 'heuristic', level, 1);
    expect(second.move).toBeTruthy();
    expect(workers.length).toBe(2);
  });

  it('fails pending work when the worker crashes and recovers on the next call', async () => {
    const opts = { silent: true };
    const { client, workers } = makeClient(opts);
    const load = client.loadNet('a', '/nets/a.bin');
    const pending = client.think(start, 'heuristic', level);
    workers[0].crash('boom');
    await expect(pending).rejects.toThrow(/boom/);
    await expect(load).rejects.toThrow(/boom/);
    expect(workers[0].terminated).toBe(true);
    opts.silent = false;
    await expect(client.think(start, 'heuristic', level)).resolves.toHaveProperty('move');
    expect(workers.length).toBe(2);
  });

  it('times out a request that never answers and restarts the worker', async () => {
    const { client, workers } = makeClient({ silent: true, watchdogMs: 30, startupGraceMs: 0 });
    await expect(client.think(start, 'heuristic', level)).rejects.toThrow(/too long/);
    expect(workers[0].terminated).toBe(true);
    expect(workers.length).toBe(2);
  });

  it('gives a fresh worker extra time to start before the watchdog applies', async () => {
    const { client, workers } = makeClient({ silent: true, watchdogMs: 20, startupGraceMs: 150 });
    const pending = client.think(start, 'heuristic', level);
    let settled = false;
    pending.then(() => (settled = true), () => (settled = true));
    await tick(80);
    expect(settled).toBe(false);
    await expect(pending).rejects.toThrow(/too long/);
    workers[1].silent = false;
    await client.think(start, 'heuristic', level);
    workers[1].silent = true;
    const t0 = performance.now();
    await expect(client.think(start, 'heuristic', level)).rejects.toThrow(/too long/);
    expect(performance.now() - t0).toBeLessThan(140);
  });

  it('dispose rejects pending and future calls', async () => {
    const { client, workers } = makeClient({ silent: true });
    const pending = client.think(start, 'heuristic', level);
    const load = client.loadNet('a', '/nets/a.bin');
    client.dispose();
    await expect(pending).rejects.toThrow(/disposed/);
    await expect(load).rejects.toThrow(/disposed/);
    await expect(client.think(start, 'heuristic', level)).rejects.toThrow(/disposed/);
    await expect(client.loadNet('a', '/nets/a.bin')).rejects.toThrow(/disposed/);
    expect(workers[0].terminated).toBe(true);
    client.cancel();
  });

  it('matches concurrent replies by request id', async () => {
    const { client } = makeClient();
    await client.loadNet('a', '/nets/a.bin');
    const fens = ['B:W18,19,24,30,31:B1,3,6,10,11', INITIAL_FEN, 'B:W18,19,26,30,32:B1,3,6,10,11'];
    const replies = await Promise.all(fens.map((startFen, i) => client.think({ startFen, moves: [] }, i === 1 ? 'a' : 'heuristic', level)));
    expect(replies[0].move).toBe('10-15');
    expect(replies[2].move).toBe('10-15');
    expect(() => new Game().play(replies[1].move)).not.toThrow();
  });

  it('rejects calls when the worker cannot be created and retries spawning later', async () => {
    let blocked = true;
    const workers: FakeWorker[] = [];
    const client = new AiClient({
      spawn: () => {
        if (blocked) throw new Error('SecurityError: worker blocked');
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
    });
    clients.push(client);
    await expect(client.think(start, 'heuristic', level)).rejects.toThrow(/worker blocked/);
    await expect(client.loadNet('a', '/nets/a.bin')).rejects.toThrow(/worker blocked/);
    blocked = false;
    await expect(client.think(start, 'heuristic', level)).resolves.toHaveProperty('move');
    expect(workers.length).toBe(1);
  });

  it('fails pending work instead of throwing when a respawn is blocked', async () => {
    let blocked = false;
    let silent = true;
    const workers: FakeWorker[] = [];
    const client = new AiClient({
      spawn: () => {
        if (blocked) throw new Error('worker blocked');
        const w = new FakeWorker();
        w.silent = silent;
        workers.push(w);
        return w;
      },
      watchdogMs: () => 30,
      startupGraceMs: 0,
    });
    clients.push(client);
    const load = client.loadNet('a', '/nets/a.bin');
    const pending = client.think(start, 'heuristic', level);
    blocked = true;
    expect(() => client.cancel()).not.toThrow();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(load).rejects.toThrow(/worker blocked/);
    blocked = false;
    const timedOut = client.think(start, 'heuristic', level);
    blocked = true;
    await expect(timedOut).rejects.toThrow(/too long/);
    blocked = false;
    silent = false;
    await expect(client.think(start, 'heuristic', level)).resolves.toHaveProperty('move');
    expect(workers.length).toBe(3);
  });
});
