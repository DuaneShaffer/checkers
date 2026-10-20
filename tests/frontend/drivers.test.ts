import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEVELS } from '../../src/ai/levels.ts';
import type { AiClientApi, AiMove, GameRef, NetId } from '../../src/ai/protocol.ts';
import { Game } from '../../src/engine/game.ts';
import { moveToString } from '../../src/engine/notation.ts';
import { INITIAL_FEN } from '../../src/engine/position.ts';
import type { Move, Position, Side, Sq } from '../../src/engine/types.ts';
import { AiDriver } from '../../src/game/aiDriver.ts';
import { GameController } from '../../src/game/controller.ts';
import type { DriverSnapshot } from '../../src/game/driver.ts';
import { LocalDriver } from '../../src/game/localDriver.ts';
import { hasMoveBy, moverOfPly } from '../../src/game/plies.ts';
import { ReviewDriver } from '../../src/game/reviewDriver.ts';
import type { BoardView, Highlights, PieceIds } from '../../src/scene/types.ts';

const sq = (pdn: number) => pdn - 1;

function record(driver: { subscribe(fn: (s: DriverSnapshot) => void): () => void }) {
  const seen: DriverSnapshot[] = [];
  driver.subscribe((s) => seen.push(s));
  return seen;
}

class FakeClient implements AiClientApi {
  calls: { ref: GameRef; netId: NetId }[] = [];
  failNets = new Set<string>();
  pick: (g: Game) => string = (g) => moveToString(g.legalMoves()[0]);
  cancelled = 0;
  #pending: { reject: (e: Error) => void }[] = [];

  async loadNet(): Promise<void> {}

  think(ref: GameRef, netId: NetId): Promise<AiMove> {
    this.calls.push({ ref: { startFen: ref.startFen, moves: [...ref.moves] }, netId });
    return new Promise((resolve, reject) => {
      this.#pending.push({ reject });
      if (this.failNets.has(netId)) return reject(new Error(`net ${netId} failed`));
      const game = Game.fromMoves(ref.moves, { startFen: ref.startFen });
      setTimeout(() => resolve({ move: this.pick(game), score: 12, depth: 2, nodes: 10, pv: [], ms: 1 }), 5);
    });
  }

  cancel(): void {
    this.cancelled++;
    for (const p of this.#pending.splice(0)) p.reject(new Error('cancelled'));
  }

  dispose(): void {}
}

describe('LocalDriver', () => {
  it('lets both sides move and rejects illegal moves', () => {
    const d = new LocalDriver();
    const seen = record(d);
    expect(seen[0]).toMatchObject({ startFen: INITIAL_FEN, moves: [], mySides: [0, 1] });
    expect(d.submitMove('11-15')).toBe(true);
    expect(d.submitMove('11-15')).toBe(false);
    expect(d.submitMove('23-19')).toBe(true);
    expect(d.snapshot().moves).toEqual(['11-15', '23-19']);
    expect(seen).toHaveLength(3);
  });

  it('undoes one ply at a time', () => {
    const d = new LocalDriver({ moves: ['11-15', '23-19'] });
    d.undo();
    expect(d.snapshot().moves).toEqual(['11-15']);
    d.undo();
    d.undo();
    expect(d.snapshot().moves).toEqual([]);
  });

  it('records a resignation by the side to move', () => {
    const d = new LocalDriver({ moves: ['11-15'] });
    d.resign();
    expect(d.snapshot().result).toEqual({ winner: 0, reason: 'resign' });
    expect(d.submitMove('23-19')).toBe(false);
    d.undo();
    expect(d.snapshot().moves).toEqual(['11-15']);
  });

  it('ends the game when the opponent is out of moves', () => {
    const d = new LocalDriver({ startFen: 'B:W14:B10' });
    expect(d.submitMove('10x17')).toBe(true);
    expect(d.snapshot().result).toEqual({ winner: 0, reason: 'no-moves' });
  });

  it('throws on a corrupt history so callers can discard it', () => {
    expect(() => new LocalDriver({ moves: ['11-15', '11-15'] })).toThrow();
  });
});

describe('AiDriver', () => {
  let client: FakeClient;
  beforeEach(() => {
    client = new FakeClient();
  });

  const make = (opts: Partial<ConstructorParameters<typeof AiDriver>[0]> = {}) =>
    new AiDriver({ engine: { client, netId: 'heuristic' }, humanSide: 0, level: LEVELS[1], minThinkMs: 0, ...opts });

  const settle = async (d: AiDriver) => {
    await vi.waitFor(() => expect(d.snapshot().thinking).toBe(false), { timeout: 2000, interval: 5 });
  };

  it('replies after the human moves and marks itself thinking meanwhile', async () => {
    const d = make();
    const seen = record(d);
    expect(d.submitMove('11-15')).toBe(true);
    expect(seen.at(-1)).toMatchObject({ moves: ['11-15'], thinking: true, mySides: [0] });
    expect(d.submitMove('9-13')).toBe(false);
    await settle(d);
    expect(d.snapshot().moves).toHaveLength(2);
    expect(client.calls[0]).toEqual({ ref: { startFen: INITIAL_FEN, moves: ['11-15'] }, netId: 'heuristic' });
  });

  it('opens the game when the human plays Ivory', async () => {
    const d = make({ humanSide: 1 });
    expect(d.snapshot().thinking).toBe(true);
    expect(d.submitMove('22-18')).toBe(false);
    await settle(d);
    expect(d.snapshot().moves).toHaveLength(1);
    expect(d.submitMove(moveToString(Game.fromMoves(d.snapshot().moves).legalMoves()[0]))).toBe(true);
  });

  it('rejects illegal and out-of-turn moves', () => {
    const d = make();
    expect(d.submitMove('22-18')).toBe(false);
    expect(d.submitMove('nonsense')).toBe(false);
  });

  it('shows the thinking state for at least the minimum time', async () => {
    vi.useFakeTimers();
    try {
      const d = make({ minThinkMs: 350 });
      d.submitMove('11-15');
      await vi.advanceTimersByTimeAsync(100);
      expect(d.snapshot().thinking).toBe(true);
      await vi.advanceTimersByTimeAsync(200);
      expect(d.snapshot().thinking).toBe(true);
      await vi.advanceTimersByTimeAsync(60);
      expect(d.snapshot().thinking).toBe(false);
      expect(d.snapshot().moves).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('undo takes back the AI reply and the human move together', async () => {
    const d = make();
    d.submitMove('11-15');
    await settle(d);
    d.submitMove(moveToString(Game.fromMoves(d.snapshot().moves).legalMoves()[0]));
    await settle(d);
    expect(d.snapshot().moves).toHaveLength(4);
    d.undo();
    expect(d.snapshot().moves).toHaveLength(2);
    expect(d.snapshot().thinking).toBe(false);
    d.undo();
    expect(d.snapshot().moves).toEqual([]);
  });

  it('undo while thinking cancels the search and ignores its late reply', async () => {
    const d = make();
    d.submitMove('11-15');
    expect(d.snapshot().thinking).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    d.undo();
    expect(client.cancelled).toBe(1);
    expect(d.snapshot()).toMatchObject({ moves: [], thinking: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(d.snapshot().moves).toEqual([]);
  });

  it('cannot undo the AI opening move when the human has not moved yet', async () => {
    const d = make({ humanSide: 1 });
    await settle(d);
    d.undo();
    expect(d.snapshot().moves).toHaveLength(1);
    expect(d.snapshot().thinking).toBe(false);
  });

  it('falls back to the heuristic when the network search fails', async () => {
    client.failNets.add('gen-5');
    const d = make({ engine: { client, netId: 'gen-5' } });
    d.submitMove('11-15');
    await settle(d);
    expect(client.calls.map((c) => c.netId)).toEqual(['gen-5', 'heuristic']);
    expect(d.snapshot().moves).toHaveLength(2);
  });

  it('reports an illegal AI move instead of playing it', async () => {
    const onError = vi.fn();
    client.pick = () => '1-5';
    const d = make({ onError });
    d.submitMove('11-15');
    await settle(d);
    expect(onError).toHaveBeenCalledOnce();
    expect(d.snapshot().moves).toEqual(['11-15']);
  });

  it('waits for a lazily loaded engine', async () => {
    let resolveEngine!: (e: { client: AiClientApi; netId: NetId }) => void;
    const d = make({ engine: new Promise((r) => (resolveEngine = r)) });
    d.submitMove('11-15');
    await new Promise((r) => setTimeout(r, 20));
    expect(client.calls).toHaveLength(0);
    resolveEngine({ client, netId: 'heuristic' });
    await settle(d);
    expect(d.snapshot().moves).toHaveLength(2);
  });

  it('retries a failed engine load on request', async () => {
    const onError = vi.fn();
    let attempts = 0;
    const d = make({
      humanSide: 1,
      onError,
      engine: () => {
        attempts++;
        if (attempts === 1) throw new Error('chunk failed to load');
        return { client, netId: 'heuristic' };
      },
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce(), { timeout: 2000, interval: 5 });
    expect(d.stalled).toBe(true);
    expect(d.snapshot()).toMatchObject({ moves: [], thinking: false });
    expect(d.retry()).toBe(true);
    expect(d.snapshot().thinking).toBe(true);
    await settle(d);
    expect(attempts).toBe(2);
    expect(d.stalled).toBe(false);
    expect(d.snapshot().moves).toHaveLength(1);
    expect(d.retry()).toBe(false);
  });

  it('reloads the engine for the next AI turn after an undo from a stall', async () => {
    let fail = true;
    const d = make({
      onError: () => undefined,
      engine: async () => {
        if (fail) throw new Error('offline');
        return { client, netId: 'heuristic' };
      },
    });
    d.submitMove('11-15');
    await vi.waitFor(() => expect(d.stalled).toBe(true), { timeout: 2000, interval: 5 });
    d.undo();
    expect(d.snapshot().moves).toEqual([]);
    fail = false;
    d.submitMove('11-15');
    await settle(d);
    expect(d.snapshot().moves).toHaveLength(2);
  });

  it('resigning awards the AI and stops any search', () => {
    const d = make();
    d.submitMove('11-15');
    d.resign();
    expect(d.snapshot()).toMatchObject({ thinking: false, result: { winner: 1, reason: 'resign' } });
    d.undo();
    expect(d.snapshot().result).toBeDefined();
  });

  it('does not think once the human has won', async () => {
    const d = make({ startFen: 'B:W14:B10' });
    expect(d.submitMove('10x17')).toBe(true);
    expect(d.snapshot()).toMatchObject({ thinking: false, result: { winner: 0, reason: 'no-moves' } });
    expect(client.calls).toHaveLength(0);
  });

  it('resumes from a saved history', async () => {
    const d = make({ moves: ['11-15', '23-19'] });
    expect(d.snapshot()).toMatchObject({ moves: ['11-15', '23-19'], thinking: false });
    const ai = make({ moves: ['11-15'] });
    expect(ai.snapshot().thinking).toBe(true);
    await settle(ai);
  });
});

describe('ReviewDriver', () => {
  it('steps through a finished game without accepting moves', () => {
    const d = new ReviewDriver(INITIAL_FEN, ['11-15', '23-19', '8-11']);
    const seen = record(d);
    expect(seen[0].moves).toHaveLength(3);
    d.step(-1);
    d.seek(0);
    d.seek(-5);
    d.step(10);
    expect(seen.map((s) => s.moves.length)).toEqual([3, 2, 0, 3]);
    expect(d.submitMove()).toBe(false);
    expect(d.snapshot().mySides).toEqual([]);
  });
});

class FakeBoard implements BoardView {
  log: string[] = [];
  highlights: Highlights = {};
  tapHandler: ((sq: Sq | null) => void) | null = null;
  position: Position | null = null;
  ids: PieceIds | null = null;

  setPosition(pos: Position, ids?: PieceIds) {
    this.position = pos;
    this.ids = ids ?? null;
    this.log.push('setPosition');
  }
  async sync(pos: Position, ids: PieceIds) {
    this.position = pos;
    this.ids = ids;
    this.log.push('sync');
  }
  async playMove(move: Move, opts?: { fromHop?: number }) {
    this.log.push(`play ${moveToString(move)}${opts?.fromHop ? ` from ${opts.fromHop}` : ''}`);
  }
  async previewHop(from: Sq, to: Sq) {
    this.log.push(`preview ${from + 1}-${to + 1}`);
  }
  cancelPreview() {
    this.log.push('cancelPreview');
  }
  setHighlights(h: Highlights) {
    this.highlights = h;
  }
  async setOrientation() {}
  squareAtClient() {
    return null;
  }
  clientOfSquare() {
    return { x: 0, y: 0 };
  }
  onSquareTap(fn: (sq: Sq | null) => void) {
    this.tapHandler = fn;
    return () => (this.tapHandler = null);
  }
  setBoardSlot() {}
  setVisible() {}
  setInstantAnimations() {}
  dispose() {}
}

class GatedPreviewBoard extends FakeBoard {
  #release: (() => void)[] = [];
  override async previewHop(from: Sq, to: Sq) {
    await super.previewHop(from, to);
    await new Promise<void>((r) => this.#release.push(r));
  }
  releaseHop() {
    this.#release.shift()?.();
  }
}

describe('hasMoveBy', () => {
  it('attributes plies to sides from the starting turn', () => {
    const fresh = { startFen: INITIAL_FEN, moves: [] };
    expect(hasMoveBy(fresh, [0, 1])).toBe(false);
    expect(hasMoveBy({ startFen: INITIAL_FEN, moves: ['11-15'] }, [1])).toBe(false);
    expect(hasMoveBy({ startFen: INITIAL_FEN, moves: ['11-15'] }, [0])).toBe(true);
    expect(hasMoveBy({ startFen: INITIAL_FEN, moves: ['11-15', '23-19'] }, [1])).toBe(true);
    expect(hasMoveBy({ startFen: 'W:W14:B10', moves: ['14-17'] }, [1])).toBe(true);
    expect(hasMoveBy({ startFen: INITIAL_FEN, moves: ['11-15', '23-19'] }, [])).toBe(false);
    expect(moverOfPly(1, 3)).toBe(0);
  });
});

describe('GameController', () => {
  afterEach(() => vi.useRealTimers());

  const flush = () => new Promise((r) => setTimeout(r, 0));
  const tap = async (board: FakeBoard, pdn: number | null) => {
    board.tapHandler?.(pdn === null ? null : sq(pdn));
    await flush();
  };

  it('sets the position on attach and offers the movable pieces', async () => {
    const driver = new LocalDriver();
    const board = new FakeBoard();
    const c = new GameController(driver, { orientation: 0 });
    c.attach(board);
    await flush();
    expect(board.log).toEqual(['setPosition']);
    expect(board.highlights.movable?.map((s) => s + 1).sort((a, b) => a - b)).toEqual([9, 10, 11, 12]);
    expect(c.view().canMove).toBe(true);
  });

  it('commits a tapped move through the driver and animates exactly one move', async () => {
    const driver = new LocalDriver();
    const board = new FakeBoard();
    const c = new GameController(driver, { orientation: 0 });
    c.attach(board);
    await flush();
    await tap(board, 11);
    expect(board.highlights.selected).toBe(sq(11));
    expect(board.highlights.targets?.map((s) => s + 1).sort()).toEqual([15, 16]);
    await tap(board, 15);
    await flush();
    expect(driver.snapshot().moves).toEqual(['11-15']);
    expect(board.log).toEqual(['setPosition', 'play 11-15']);
    expect(board.highlights.lastMove).toEqual([sq(11), sq(15)]);
    expect(c.view().position.turn).toBe(1);
  });

  it('previews intermediate hops and continues the animation from them', async () => {
    const driver = new LocalDriver({ startFen: 'B:W6,15,23,24:B1' });
    const board = new FakeBoard();
    const c = new GameController(driver, { orientation: 0 });
    c.attach(board);
    await flush();
    await tap(board, 1);
    await tap(board, 10);
    expect(board.log).toEqual(['setPosition', 'preview 1-10', 'preview 10-19']);
    expect(board.highlights.pending).toEqual([sq(6), sq(15)]);
    await tap(board, 28);
    await flush();
    expect(driver.snapshot().moves).toEqual(['1x10x19x28']);
    expect(board.log.at(-1)).toBe('play 1x10x19x28 from 2');
    c.dispose();
  });

  it('stops previewing hops once the position changes mid-preview', async () => {
    const driver = new LocalDriver({ startFen: 'B:W6,15,23,24,30:B1,9' });
    const board = new GatedPreviewBoard();
    const c = new GameController(driver, { orientation: 0 });
    c.attach(board);
    await flush();
    await tap(board, 1);
    await tap(board, 10);
    expect(board.log).toEqual(['setPosition', 'preview 1-10']);
    driver.resign();
    board.releaseHop();
    await flush();
    board.releaseHop();
    await flush();
    expect(board.log).toEqual(['setPosition', 'preview 1-10', 'cancelPreview']);
    c.dispose();
  });

  it('cancels a preview with Escape', async () => {
    const driver = new LocalDriver({ startFen: 'B:W6,15,23,24:B1' });
    const board = new FakeBoard();
    const c = new GameController(driver, { orientation: 0 });
    c.attach(board);
    await flush();
    await tap(board, 1);
    await tap(board, 10);
    c.cancel();
    await flush();
    expect(board.log.at(-1)).toBe('cancelPreview');
    expect(board.highlights.selected ?? null).toBeNull();
  });

  it('snaps with sync for undo and other non-incremental changes', async () => {
    const driver = new LocalDriver({ moves: ['11-15', '23-19'] });
    const board = new FakeBoard();
    const c = new GameController(driver, { orientation: 0 });
    c.attach(board);
    await flush();
    driver.undo();
    await flush();
    expect(board.log).toEqual(['setPosition', 'sync']);
    expect(c.view().snapshot.moves).toEqual(['11-15']);
    expect(board.ids?.[sq(15)]).not.toBe(-1);
  });

  it('ignores taps while it is not the human turn', async () => {
    const client = new FakeClient();
    const driver = new AiDriver({ engine: { client, netId: 'heuristic' }, humanSide: 1, level: LEVELS[1], minThinkMs: 0 });
    const board = new FakeBoard();
    const c = new GameController(driver, { orientation: 1 });
    c.attach(board);
    await tap(board, 22);
    expect(board.highlights.selected ?? null).toBeNull();
    await vi.waitFor(() => expect(driver.snapshot().moves).toHaveLength(1));
    await flush();
    expect(board.log).toContain(`play ${driver.snapshot().moves[0]}`);
    expect(c.view().canMove).toBe(true);
  });

  it('reports the game result after a short beat', async () => {
    const driver = new LocalDriver({ startFen: 'B:W14:B10' });
    const board = new FakeBoard();
    const gameOver = vi.fn();
    const c = new GameController(driver, { orientation: 0, gameOverDelayMs: 10, hooks: { gameOver } });
    c.attach(board);
    await flush();
    await tap(board, 10);
    await tap(board, 17);
    await vi.waitFor(() => expect(gameOver).toHaveBeenCalledOnce());
    expect(gameOver.mock.calls[0][0]).toEqual({ winner: 0, reason: 'no-moves' });
    expect(c.status()).toEqual({ over: true, winner: 0, reason: 'no-moves' });
  });

  it('moves a keyboard cursor and activates squares with it', async () => {
    const driver = new LocalDriver();
    const board = new FakeBoard();
    const c = new GameController(driver, { orientation: 0 });
    c.attach(board);
    await flush();
    c.moveCursor('up');
    const start = c.cursor!;
    expect([9, 10, 11, 12]).toContain(start + 1);
    c.activateCursor();
    await flush();
    expect(board.highlights.selected).toBe(start);
    const side: Side = 0;
    expect(c.orientation).toBe(side);
  });
});
