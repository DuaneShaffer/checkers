import { describe, expect, it } from 'vitest';
import { Game } from '../../src/engine/game.ts';
import { INITIAL_FEN } from '../../src/engine/position.ts';
import { mulberry32 } from '../../src/engine/rng.ts';
import { AiWorkerCore } from '../../src/ai/ai.worker.ts';
import { LEVELS, type LevelSpec } from '../../src/ai/levels.ts';
import { Network } from '../../src/ai/network.ts';
import type { AiRequest, AiResponse } from '../../src/ai/protocol.ts';
import { DEFAULT_LAYERS } from '../../src/shared/formats.ts';

type MoveResponse = Extract<AiResponse, { type: 'move' }>;

function setup(files: Record<string, ArrayBuffer> = {}, delayMs = 0) {
  const out: AiResponse[] = [];
  const core = new AiWorkerCore({
    post: (msg) => out.push(structuredClone(msg)),
    ttBits: 16,
    fetchBytes: async (url) => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const file = files[url];
      if (!file) throw new Error(`HTTP 404 for ${url}`);
      return file.slice(0);
    },
  });
  const send = (req: AiRequest) => core.handle(structuredClone(req));
  return { core, out, send };
}

const think = (reqId: number, netId: string, moves: string[], level: LevelSpec, seed?: number, startFen = INITIAL_FEN): AiRequest =>
  ({ type: 'think', reqId, netId, startFen, moves, level, seed });

const quick: LevelSpec = { maxDepth: 4, timeMs: 1000, temperature: 0, blunderRate: 0, threatExtension: false };

function netFile(seed: number, gen: number): ArrayBuffer {
  return Network.random(DEFAULT_LAYERS, mulberry32(seed), gen).toBinary();
}

describe('AI worker message handler', () => {
  it('answers a level-1 heuristic request quickly with a legal move', async () => {
    const { out, send } = setup();
    const t0 = performance.now();
    await send(think(1, 'heuristic', [], LEVELS[1], 7));
    expect(performance.now() - t0).toBeLessThan(300);
    const reply = out[0] as MoveResponse;
    expect(reply.type).toBe('move');
    expect(reply.reqId).toBe(1);
    expect(new Game().legalMoves().map((m) => m.path.map((s) => s + 1).join('-'))).toContain(reply.move);
    expect(reply.ms).toBeLessThan(300);
    expect(reply.pv[0]).toBe(reply.move);
  });

  it('replays the game and answers for the side to move', async () => {
    const { out, send } = setup();
    const moves = ['11-15', '23-19', '8-11', '22-17'];
    await send(think(2, 'heuristic', moves, quick));
    const reply = out[0] as MoveResponse;
    const game = Game.fromMoves(moves);
    expect(() => game.play(reply.move)).not.toThrow();
    expect(reply.depth).toBe(4);
    expect(reply.nodes).toBeGreaterThan(0);
  });

  it('starts from a custom FEN', async () => {
    const { out, send } = setup();
    await send(think(3, 'heuristic', [], quick, 1, 'B:W18,19,24,30,31:B1,3,6,10,11'));
    expect((out[0] as MoveResponse).move).toBe('10-15');
    expect((out[0] as MoveResponse).score).toBeGreaterThan(80);
  });

  it('loads a CKN1 net and thinks with it', async () => {
    const { out, send } = setup({ '/nets/a.bin': netFile(1, 12) });
    await send({ type: 'loadNet', netId: 'g12', url: '/nets/a.bin' });
    expect(out[0]).toEqual({ type: 'netLoaded', netId: 'g12', gen: 12 });
    await send(think(4, 'g12', [], quick));
    expect(out[1].type).toBe('move');
  });

  it('waits for a net that is still loading', async () => {
    const { out, send } = setup({ '/nets/b.bin': netFile(2, 3) }, 30);
    const load = send({ type: 'loadNet', netId: 'g3', url: '/nets/b.bin' });
    const reply = send(think(5, 'g3', [], quick));
    await Promise.all([load, reply]);
    expect(out.map((r) => r.type)).toEqual(['netLoaded', 'move']);
  });

  it('reports load failures without a request id, in request order', async () => {
    const { out, send } = setup({ '/nets/ok.bin': netFile(3, 1), '/nets/bad.bin': new ArrayBuffer(8) }, 5);
    await Promise.all([
      send({ type: 'loadNet', netId: 'missing', url: '/nets/none.bin' }),
      send({ type: 'loadNet', netId: 'bad', url: '/nets/bad.bin' }),
      send({ type: 'loadNet', netId: 'ok', url: '/nets/ok.bin' }),
    ]);
    expect(out[0]).toMatchObject({ type: 'error', message: expect.stringMatching(/missing.*404/) });
    expect(out[0]).not.toHaveProperty('reqId');
    expect(out[1]).toMatchObject({ type: 'error', message: expect.stringMatching(/bad.*too short/) });
    expect(out[2]).toEqual({ type: 'netLoaded', netId: 'ok', gen: 1 });
  });

  it('reports request errors with the request id', async () => {
    const { out, send } = setup();
    await send(think(6, 'nope', [], quick));
    await send(think(7, 'heuristic', ['11-15', '11-15'], quick));
    await send(think(8, 'heuristic', [], quick, 1, 'B:W1:B'));
    await send(think(9, 'heuristic', [], { ...quick, maxDepth: 0 }));
    expect(out).toEqual([
      { type: 'error', reqId: 6, message: expect.stringMatching(/not loaded/) },
      { type: 'error', reqId: 7, message: expect.stringMatching(/Illegal move at index 1/) },
      { type: 'error', reqId: 8, message: expect.stringMatching(/over/) },
      { type: 'error', reqId: 9, message: expect.stringMatching(/level/) },
    ]);
  });

  it('rejects unknown request types', async () => {
    const { out, core } = setup();
    await core.handle({ type: 'bogus' } as unknown as AiRequest);
    expect(out[0]).toMatchObject({ type: 'error' });
  });

  it('is deterministic for a seed and varies across seeds at low levels', async () => {
    const { out, send } = setup();
    for (let i = 0; i < 2; i++) await send(think(10 + i, 'heuristic', [], LEVELS[1], 99));
    const [a, b] = out as MoveResponse[];
    expect(a.move).toBe(b.move);
    const seen = new Set<string>();
    for (let seed = 0; seed < 40; seed++) {
      await send(think(100 + seed, 'heuristic', [], LEVELS[1], seed));
      seen.add((out.at(-1) as MoveResponse).move);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('plays the best move at deterministic levels', async () => {
    const { out, send } = setup();
    const fen = 'B:W18,19,26,30,32:B1,3,6,10,11';
    for (let seed = 0; seed < 5; seed++) await send(think(200 + seed, 'heuristic', [], LEVELS[4], seed, fen));
    expect(new Set((out as MoveResponse[]).map((r) => r.move))).toEqual(new Set(['10-15']));
  });

  it('honours the time budget and answers forced moves immediately', async () => {
    const { out, send } = setup();
    const t0 = performance.now();
    await send(think(300, 'heuristic', [], { ...quick, maxDepth: 40, timeMs: 120 }));
    expect(performance.now() - t0).toBeLessThan(600);
    const t1 = performance.now();
    await send(think(301, 'heuristic', ['11-15', '22-18'], LEVELS[5]));
    expect(performance.now() - t1).toBeLessThan(300);
    expect(out.map((r) => r.type)).toEqual(['move', 'move']);
    expect((out[1] as MoveResponse).move).toBe('15x22');
  });

  it('switches between nets for a gen-vs-gen match', async () => {
    const { out, send } = setup({ '/a.bin': netFile(4, 1), '/b.bin': netFile(5, 2) });
    await send({ type: 'loadNet', netId: 'a', url: '/a.bin' });
    await send({ type: 'loadNet', netId: 'b', url: '/b.bin' });
    const game = new Game();
    for (let ply = 0; ply < 10; ply++) {
      await send(think(400 + ply, ply % 2 === 0 ? 'a' : 'b', game.notation(), quick, ply));
      game.play((out.at(-1) as MoveResponse).move);
    }
    expect(game.moves.length).toBe(10);
  });
});
