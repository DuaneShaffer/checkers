import type { AppContext, GameScreenHandle, Screen } from '../app/contracts.ts';
import type { LevelSpec } from '../ai/levels.ts';
import type { AiClientApi, NetId } from '../ai/protocol.ts';
import { Game } from '../engine/game.ts';
import type { Side } from '../engine/types.ts';
import type { DriverSnapshot, GameDriver } from '../game/driver.ts';
import type { GameResult } from '../net/protocol.ts';
import type { TrainingManifest } from '../shared/formats.ts';
import type { LabData } from './data.ts';
import { THINK_PRESETS, liveRoute } from './livePicker.ts';

export interface LiveSeat {
  netId: NetId;
  url?: string;
  label: string;
}

export interface LiveMatchOptions {
  client: AiClientApi;
  seats: readonly [LiveSeat, LiveSeat];
  thinkMs: number;
  paceMs?: number;
  seed?: number;
  onNotice?(message: string): void;
  onError?(message: string): void;
}

const MIN_PLY_MS = 650;

export function liveLevel(thinkMs: number): LevelSpec {
  return { maxDepth: 16, timeMs: thinkMs, temperature: 0.03, blunderRate: 0, threatExtension: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class LiveMatchDriver implements GameDriver {
  private readonly opts: LiveMatchOptions;
  private readonly game = new Game();
  private readonly listeners = new Set<(s: DriverSnapshot) => void>();
  private readonly netIds: [NetId, NetId];
  private result: GameResult | undefined;
  private thinking = false;
  private disposed = false;
  private thinkMs: number;

  constructor(opts: LiveMatchOptions) {
    this.opts = opts;
    this.thinkMs = opts.thinkMs;
    this.netIds = [opts.seats[0].netId, opts.seats[1].netId];
  }

  start(): void {
    void this.run();
  }

  setThinkMs(ms: number): void {
    this.thinkMs = ms;
  }

  subscribe(fn: (s: DriverSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  snapshot(): DriverSnapshot {
    const snap: DriverSnapshot = { startFen: this.game.startFen, moves: this.game.notation(), mySides: [], thinking: this.thinking };
    if (this.result) snap.result = this.result;
    return snap;
  }

  submitMove(): boolean {
    return false;
  }

  resign(): void {
    if (this.result || this.disposed) return;
    this.opts.client.cancel();
    this.finish({ winner: (1 - this.game.position.turn) as Side, reason: 'resign' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.opts.client.cancel();
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }

  private finish(result: GameResult): void {
    this.result = result;
    this.thinking = false;
    this.emit();
  }

  private async loadNets(): Promise<void> {
    const loaded = new Map<string, Promise<boolean>>();
    for (let side = 0; side < 2; side++) {
      const seat = this.opts.seats[side];
      if (seat.netId === 'heuristic' || !seat.url) continue;
      let p = loaded.get(seat.netId);
      if (!p) {
        p = this.opts.client.loadNet(seat.netId, seat.url).then(() => true, () => false);
        loaded.set(seat.netId, p);
      }
      if (!(await p)) {
        this.netIds[side] = 'heuristic';
        this.opts.onNotice?.(`Couldn't load ${seat.label}'s network; it plays with the heuristic instead`);
      }
    }
  }

  private async run(): Promise<void> {
    await this.loadNets();
    const seed = this.opts.seed ?? Math.floor(Math.random() * 2 ** 31);
    while (!this.disposed && !this.result) {
      const status = this.game.status();
      if (status.over) {
        this.finish({ winner: status.winner, reason: status.reason });
        return;
      }
      const side = this.game.position.turn;
      this.thinking = true;
      this.emit();
      const started = performance.now();
      let reply;
      try {
        reply = await this.opts.client.think({ startFen: this.game.startFen, moves: this.game.notation() }, this.netIds[side], liveLevel(this.thinkMs), seed + this.game.ply);
      } catch (e) {
        if (this.disposed || this.result) return;
        this.thinking = false;
        this.emit();
        this.opts.onError?.(`The AI stopped: ${(e as Error).message ?? e}`);
        return;
      }
      if (this.disposed || this.result) return;
      const wait = Math.max(MIN_PLY_MS, this.thinkMs) - (performance.now() - started);
      if (wait > 0) await sleep(wait);
      if (this.disposed || this.result) return;
      try {
        this.game.play(reply.move);
      } catch {
        this.thinking = false;
        this.emit();
        this.opts.onError?.(`The AI suggested an illegal move (${reply.move})`);
        return;
      }
      this.thinking = false;
      this.emit();
    }
  }
}

export async function loadAiClient(): Promise<AiClientApi> {
  const { createAiClient } = await import('../ai/client.ts');
  return createAiClient();
}

interface SeriesScore { wins: Map<number, number>; draws: number }
const series = new Map<string, SeriesScore>();

function seriesKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function seriesText(a: number, b: number): string {
  const sc = series.get(seriesKey(a, b));
  if (!sc) return '';
  const aw = sc.wins.get(a) ?? 0;
  const bw = sc.wins.get(b) ?? 0;
  return a === b ? `Series: ${aw} decisive, ${sc.draws} drawn` : `Series: Gen ${a} ${aw} – ${bw} Gen ${b}, ${sc.draws} drawn`;
}

function recordResult(a: number, b: number, winner: Side | null): void {
  const key = seriesKey(a, b);
  const sc = series.get(key) ?? { wins: new Map<number, number>(), draws: 0 };
  if (winner === null) sc.draws++;
  else {
    const gen = winner === 0 ? a : b;
    sc.wins.set(gen, (sc.wins.get(gen) ?? 0) + 1);
  }
  series.set(key, sc);
}

export interface LiveMatchParams {
  ctx: AppContext;
  data: LabData;
  manifest: TrainingManifest;
  a: number;
  b: number;
  thinkMs: number;
  cancelled(): boolean;
}

export async function startLiveMatch(p: LiveMatchParams): Promise<Screen | null> {
  const { ctx, data, manifest, a, b } = p;
  const genA = manifest.generations.find((g) => g.gen === a && g.net);
  const genB = manifest.generations.find((g) => g.gen === b && g.net);
  if (!genA || !genB) throw new Error('Both generations need a published network');
  const client = await loadAiClient();
  if (p.cancelled()) {
    client.dispose();
    return null;
  }
  let thinkMs = p.thinkMs;
  let handle: GameScreenHandle | null = null;
  const driver = new LiveMatchDriver({
    client,
    seats: [
      { netId: `gen-${a}`, url: data.url(genA.net!), label: `Gen ${a}` },
      { netId: `gen-${b}`, url: data.url(genB.net!), label: `Gen ${b}` },
    ],
    thinkMs,
    onNotice: (m) => ctx.toast(m, 'info'),
    onError: (m) => ctx.toast(m, 'error'),
  });

  const title = `Gen ${a} vs Gen ${b}`;
  const baseSubtitle = `Crimson: Gen ${a} · Ivory: Gen ${b}`;
  let recorded = false;
  const unsubscribe = driver.subscribe((snap) => {
    if (!handle) return;
    if (snap.result && !recorded) {
      recorded = true;
      recordResult(a, b, snap.result.winner);
      handle.setTitle(title, seriesText(a, b) || baseSubtitle);
      setActions(true);
    }
  });

  function presetLabel(): string {
    return THINK_PRESETS.find((t) => t.ms === thinkMs)?.label ?? `${thinkMs} ms`;
  }

  function setActions(finished: boolean): void {
    const actions = [
      {
        label: `Think: ${presetLabel()}`,
        onClick: () => {
          const i = THINK_PRESETS.findIndex((t) => t.ms === thinkMs);
          thinkMs = THINK_PRESETS[(i + 1) % THINK_PRESETS.length].ms;
          driver.setThinkMs(thinkMs);
          history.replaceState(history.state, '', `${location.pathname}${location.search}${liveRoute(a, b, thinkMs)}`);
          setActions(finished);
        },
      },
      { label: finished ? 'Next game (swap colors)' : 'Swap colors', onClick: () => ctx.navigate(liveRoute(b, a, thinkMs)) },
      { label: 'Change matchup', onClick: () => ctx.navigate(`#/lab/live?a=${a}&b=${b}`) },
    ];
    handle?.setExtraActions(actions);
  }

  handle = ctx.playGame(driver, { mode: 'live-match', orientation: 0, title, subtitle: seriesText(a, b) || baseSubtitle });
  setActions(false);
  driver.start();

  return {
    dispose() {
      unsubscribe();
      driver.dispose();
      client.dispose();
      handle?.dispose();
    },
  };
}
