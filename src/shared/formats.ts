import type { EndReason, ResultStr } from '../engine/types.ts';

export type BaselineId = 'random' | 'heur2' | 'heur4' | 'heur6';
export type PlayerId = number | BaselineId | 'human';
export type OpponentKey = BaselineId | 'prev' | 'prev10';

export interface WDL { w: number; d: number; l: number }

export interface GenerationSummary {
  gen: number;
  games: number;
  hours: number;
  depth: number;
  elo: number;
  eloErr: number;
  vs: Partial<Record<OpponentKey, WDL>>;
  avgPlies: number;
  decisive: number;
  loss: number;
  replay: string | null;
  net: string | null;
}

export interface TrainingManifest {
  format: 1;
  rules: 'english-draughts';
  run: string;
  updated: string;
  net: { layers: number[] };
  totalGames: number;
  hours: number;
  champion: number | null;
  anchor: { id: 'heur4'; elo: 1000 };
  baselines: { id: BaselineId; name: string; elo: number }[];
  generations: GenerationSummary[];
}

export interface GameRecord {
  id: string;
  kind: 'selfplay' | 'gauntlet';
  black: PlayerId;
  white: PlayerId;
  startFen?: string;
  moves: string[];
  result: ResultStr;
  reason: EndReason;
  evals?: number[];
  random?: number[];
  explore?: number[];
}

export interface GenFile { format: 1; gen: number; games: GameRecord[] }

export const CKN1_MAGIC = 'CKN1';
export const CKN1_VERSION = 1;
export const DEFAULT_LAYERS = [132, 64, 32, 1] as const;

export const TRAINING_BUDGET_BYTES = 5 * 1024 * 1024;
export const GEN_FILE_BUDGET_BYTES = 300 * 1024;
export const MAX_SHIPPED_NETS = 28;

export function ckn1HeaderBytes(nLayers: number): number {
  return 4 * (4 + nLayers);
}

export function ckn1ParamCount(layers: readonly number[]): number {
  let n = 0;
  for (let i = 1; i < layers.length; i++) n += layers[i - 1] * layers[i] + layers[i];
  return n;
}

export function emptyManifest(): TrainingManifest {
  return {
    format: 1,
    rules: 'english-draughts',
    run: '',
    updated: '',
    net: { layers: [...DEFAULT_LAYERS] },
    totalGames: 0,
    hours: 0,
    champion: null,
    anchor: { id: 'heur4', elo: 1000 },
    baselines: [],
    generations: [],
  };
}

export function isTrainingManifest(x: unknown): x is TrainingManifest {
  const m = x as TrainingManifest;
  return !!m && m.format === 1 && m.rules === 'english-draughts' && Array.isArray(m.generations) && Array.isArray(m.baselines);
}

export function isGenFile(x: unknown): x is GenFile {
  const g = x as GenFile;
  return !!g && g.format === 1 && Number.isInteger(g.gen) && Array.isArray(g.games)
    && g.games.every((r) => !!r && typeof r.id === 'string' && Array.isArray(r.moves));
}
