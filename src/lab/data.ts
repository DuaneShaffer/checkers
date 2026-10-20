import type { EndReason, ResultStr } from '../engine/types.ts';
import {
  isTrainingManifest,
  type BaselineId,
  type GameRecord,
  type GenFile,
  type GenerationSummary,
  type OpponentKey,
  type PlayerId,
  type TrainingManifest,
  type WDL,
} from '../shared/formats.ts';

export type LabErrorKind = 'network' | 'missing' | 'invalid';

export class LabDataError extends Error {
  readonly kind: LabErrorKind;
  readonly url: string;
  constructor(kind: LabErrorKind, url: string, message: string) {
    super(message);
    this.name = 'LabDataError';
    this.kind = kind;
    this.url = url;
  }
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface LabDataOptions {
  base?: string;
  fetch?: FetchFn;
}

export interface LabData {
  manifest(opts?: { refresh?: boolean }): Promise<TrainingManifest>;
  genFile(gen: number): Promise<GenFile>;
  game(gen: number, id: string): Promise<GameRecord>;
  url(relative: string): string;
}

const BASELINE_IDS: readonly BaselineId[] = ['random', 'heur2', 'heur4', 'heur6'];
const OPPONENT_KEYS: readonly OpponentKey[] = ['random', 'heur2', 'heur4', 'heur6', 'prev', 'prev10'];
const RESULTS: readonly ResultStr[] = ['1-0', '0-1', '1/2-1/2'];
const END_REASONS: readonly EndReason[] = ['no-moves', 'repetition', 'no-progress', 'max-plies', 'resign', 'agreement'];

export function createLabData(opts: LabDataOptions = {}): LabData {
  const base = trainingBase(opts.base ?? import.meta.env.BASE_URL);
  const doFetch: FetchFn = opts.fetch ?? ((u, init) => fetch(u, init));
  let manifestPromise: Promise<TrainingManifest> | null = null;
  const genPromises = new Map<number, Promise<GenFile>>();

  const url = (relative: string): string => base + relative.replace(/^\.?\//, '');

  function manifest(o: { refresh?: boolean } = {}): Promise<TrainingManifest> {
    if (!manifestPromise || o.refresh) {
      const p = fetchJson(doFetch, url('manifest.json'), { cache: 'no-cache' }).then((json) => parseManifest(json, url('manifest.json')));
      manifestPromise = p;
      p.catch(() => { if (manifestPromise === p) manifestPromise = null; });
    }
    return manifestPromise;
  }

  function genFile(gen: number): Promise<GenFile> {
    let p = genPromises.get(gen);
    if (!p) {
      p = manifest().then((m) => {
        const summary = m.generations.find((g) => g.gen === gen);
        if (!summary) throw new LabDataError('missing', url('manifest.json'), `Generation ${gen} is not in the manifest`);
        if (!summary.replay) throw new LabDataError('missing', url('manifest.json'), `Generation ${gen} has no sampled games`);
        const u = url(summary.replay);
        return fetchJson(doFetch, u).then((json) => parseGenFile(json, gen, u));
      });
      const stored = p;
      genPromises.set(gen, stored);
      stored.catch(() => { if (genPromises.get(gen) === stored) genPromises.delete(gen); });
    }
    return p;
  }

  async function game(gen: number, id: string): Promise<GameRecord> {
    const file = await genFile(gen);
    const rec = file.games.find((g) => g.id === id);
    if (!rec) throw new LabDataError('missing', url(`gen ${gen}`), `Game ${id} is not in generation ${gen}`);
    return rec;
  }

  return { manifest, genFile, game, url };
}

function trainingBase(base: string): string {
  return (base.endsWith('/') ? base : base + '/') + 'training/';
}

async function fetchJson(doFetch: FetchFn, url: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await doFetch(url, init);
  } catch (e) {
    throw new LabDataError('network', url, `Couldn't reach ${url}: ${(e as Error).message ?? e}`);
  }
  if (res.status === 404) throw new LabDataError('missing', url, `${url} was not found`);
  if (!res.ok) throw new LabDataError('network', url, `${url} returned ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new LabDataError('invalid', url, `${url} is not valid JSON`);
  }
}

const isFiniteNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isCount = (x: unknown): x is number => isFiniteNum(x) && x >= 0;

function parseWdl(x: unknown): WDL | null {
  const w = x as WDL;
  if (!w || typeof w !== 'object' || !isCount(w.w) || !isCount(w.d) || !isCount(w.l)) return null;
  return { w: w.w, d: w.d, l: w.l };
}

function parseGeneration(x: unknown): GenerationSummary | null {
  const g = x as GenerationSummary;
  if (!g || typeof g !== 'object' || !Number.isInteger(g.gen) || g.gen < 0 || !isFiniteNum(g.elo)) return null;
  const vs: GenerationSummary['vs'] = {};
  if (g.vs && typeof g.vs === 'object') {
    for (const key of OPPONENT_KEYS) {
      const wdl = parseWdl(g.vs[key]);
      if (wdl && wdl.w + wdl.d + wdl.l > 0) vs[key] = wdl;
    }
  }
  return {
    gen: g.gen,
    games: isCount(g.games) ? g.games : 0,
    hours: isCount(g.hours) ? g.hours : 0,
    depth: isCount(g.depth) ? g.depth : 0,
    elo: g.elo,
    eloErr: isCount(g.eloErr) ? g.eloErr : 0,
    vs,
    avgPlies: isCount(g.avgPlies) ? g.avgPlies : 0,
    decisive: isCount(g.decisive) ? g.decisive : 0,
    loss: isFiniteNum(g.loss) ? g.loss : 0,
    replay: typeof g.replay === 'string' && g.replay ? g.replay : null,
    net: typeof g.net === 'string' && g.net ? g.net : null,
  };
}

export function parseManifest(json: unknown, source = 'manifest.json'): TrainingManifest {
  if (!isTrainingManifest(json)) throw new LabDataError('invalid', source, 'Training manifest has an unexpected format');
  const byGen = new Map<number, GenerationSummary>();
  for (const raw of json.generations) {
    const g = parseGeneration(raw);
    if (g) byGen.set(g.gen, g);
  }
  const generations = [...byGen.values()].sort((a, b) => a.gen - b.gen);
  const baselines = json.baselines.filter((b): b is TrainingManifest['baselines'][number] =>
    !!b && BASELINE_IDS.includes(b.id) && typeof b.name === 'string' && isFiniteNum(b.elo));
  const champion = Number.isInteger(json.champion) && byGen.has(json.champion as number) ? json.champion : null;
  return {
    format: 1,
    rules: 'english-draughts',
    run: typeof json.run === 'string' ? json.run : '',
    updated: typeof json.updated === 'string' ? json.updated : '',
    net: { layers: Array.isArray(json.net?.layers) ? json.net.layers.filter(Number.isInteger) : [] },
    totalGames: isCount(json.totalGames) ? json.totalGames : (generations.at(-1)?.games ?? 0),
    hours: isCount(json.hours) ? json.hours : (generations.at(-1)?.hours ?? 0),
    champion,
    anchor: { id: 'heur4', elo: 1000 },
    baselines,
    generations,
  };
}

function isPlayerId(x: unknown): x is PlayerId {
  return (Number.isInteger(x) && (x as number) >= 0) || x === 'human' || BASELINE_IDS.includes(x as BaselineId);
}

function parseGameRecord(x: unknown): GameRecord | null {
  const r = x as GameRecord;
  if (!r || typeof r.id !== 'string' || !r.id) return null;
  if (r.kind !== 'selfplay' && r.kind !== 'gauntlet') return null;
  if (!isPlayerId(r.black) || !isPlayerId(r.white)) return null;
  if (!Array.isArray(r.moves) || !r.moves.every((m) => typeof m === 'string')) return null;
  if (!RESULTS.includes(r.result) || !END_REASONS.includes(r.reason)) return null;
  if (r.startFen !== undefined && typeof r.startFen !== 'string') return null;
  const rec: GameRecord = { id: r.id, kind: r.kind, black: r.black, white: r.white, moves: r.moves, result: r.result, reason: r.reason };
  if (r.startFen) rec.startFen = r.startFen;
  if (Array.isArray(r.evals) && r.evals.every(isFiniteNum)) rec.evals = r.evals;
  if (Array.isArray(r.random)) rec.random = r.random.filter(Number.isInteger);
  if (Array.isArray(r.explore)) rec.explore = r.explore.filter(Number.isInteger);
  return rec;
}

function isGenEnvelope(x: unknown): x is { format: 1; gen: number; games: unknown[] } {
  const f = x as GenFile | null;
  return !!f && typeof f === 'object' && f.format === 1 && Number.isInteger(f.gen) && Array.isArray(f.games);
}

export function parseGenFile(json: unknown, expectedGen: number, source = `gen ${expectedGen}`): GenFile {
  if (!isGenEnvelope(json)) throw new LabDataError('invalid', source, `Generation ${expectedGen} file has an unexpected format`);
  if (json.gen !== expectedGen) throw new LabDataError('invalid', source, `Expected generation ${expectedGen}, file says ${json.gen}`);
  const seen = new Set<string>();
  const games: GameRecord[] = [];
  for (const raw of json.games) {
    const rec = parseGameRecord(raw);
    if (rec && !seen.has(rec.id)) {
      seen.add(rec.id);
      games.push(rec);
    }
  }
  return { format: 1, gen: json.gen, games };
}

const DEFAULT_BASELINE_NAMES: Record<BaselineId, string> = {
  random: 'Random mover',
  heur2: 'Heuristic d2',
  heur4: 'Heuristic d4',
  heur6: 'Heuristic d6',
};

export function baselineName(m: TrainingManifest | null, id: BaselineId): string {
  return m?.baselines.find((b) => b.id === id)?.name ?? DEFAULT_BASELINE_NAMES[id];
}

export function playerName(m: TrainingManifest | null, p: PlayerId): string {
  if (typeof p === 'number') return `Gen ${p}`;
  if (p === 'human') return 'Human';
  return baselineName(m, p);
}

export function opponentLabel(m: TrainingManifest | null, key: OpponentKey, gen: number): string {
  if (key === 'prev') return `Gen ${Math.max(0, gen - 1)}`;
  if (key === 'prev10') return `Gen ${Math.max(0, gen - 10)}`;
  return baselineName(m, key);
}

export function orderedOpponents(vs: GenerationSummary['vs']): OpponentKey[] {
  return OPPONENT_KEYS.filter((k) => vs[k]);
}

export function findGeneration(m: TrainingManifest, gen: number): GenerationSummary | undefined {
  return m.generations.find((g) => g.gen === gen);
}

export function previousGeneration(m: TrainingManifest, gen: number): GenerationSummary | undefined {
  let prev: GenerationSummary | undefined;
  for (const g of m.generations) {
    if (g.gen >= gen) break;
    prev = g;
  }
  return prev;
}

export function nextGeneration(m: TrainingManifest, gen: number): GenerationSummary | undefined {
  return m.generations.find((g) => g.gen > gen);
}

export function generationsWithNets(m: TrainingManifest): GenerationSummary[] {
  return m.generations.filter((g) => g.net);
}

export function generationsWithReplays(m: TrainingManifest): GenerationSummary[] {
  return m.generations.filter((g) => g.replay);
}

export function defaultGeneration(m: TrainingManifest): number | null {
  if (m.champion !== null) return m.champion;
  return m.generations.at(-1)?.gen ?? null;
}

let shared: LabData | null = null;

export function labData(): LabData {
  shared ??= createLabData();
  return shared;
}
