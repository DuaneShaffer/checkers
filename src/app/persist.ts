import type { LevelId } from '../ai/levels.ts';
import { fromFen } from '../engine/position.ts';
import type { Side } from '../engine/types.ts';
import type { GameResult } from '../net/protocol.ts';

const PREFIX = 'checkers:';

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readJson<T = unknown>(key: string): T | null {
  try {
    const raw = storage()?.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    storage()?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* quota or disabled storage: persistence is best-effort */
  }
}

export function removeKey(key: string): void {
  try {
    storage()?.removeItem(PREFIX + key);
  } catch {
    return;
  }
}

export interface ResumeRecord {
  v: 1;
  mode: 'ai' | 'local';
  id?: string;
  startFen: string;
  moves: string[];
  humanSide?: Side;
  level?: LevelId;
  gen?: number | null;
  savedAt: number;
}

export interface FinishedGame {
  v: 1;
  mode: 'ai' | 'local' | 'online' | 'live-match';
  startFen: string;
  moves: string[];
  result: GameResult;
  mySides?: Side[];
  orientation: Side;
  title: string;
}

const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === 'string');
const isSideArray = (x: unknown): x is Side[] => Array.isArray(x) && x.every((s) => s === 0 || s === 1);

function isFen(x: unknown): x is string {
  if (typeof x !== 'string') return false;
  try {
    fromFen(x);
    return true;
  } catch {
    return false;
  }
}

export function loadResume(): ResumeRecord | null {
  const r = readJson<ResumeRecord>('resume');
  if (!r || r.v !== 1 || (r.mode !== 'ai' && r.mode !== 'local') || !isFen(r.startFen) || !isStringArray(r.moves)) return null;
  if (r.mode === 'ai' && (r.humanSide !== 0 && r.humanSide !== 1)) return null;
  if (r.id !== undefined && typeof r.id !== 'string') return null;
  return r;
}

export function saveResume(r: Omit<ResumeRecord, 'v' | 'savedAt'>): void {
  writeJson('resume', { v: 1, savedAt: Date.now(), ...r });
}

export function clearResume(): void {
  removeKey('resume');
}

export const LATEST_RESUME = '1';

export function newResumeId(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function findResume(token: string | null, mode: ResumeRecord['mode']): ResumeRecord | 'gone' | null {
  if (!token) return null;
  const r = loadResume();
  if (r?.mode === mode && (token === LATEST_RESUME || r.id === token)) return r;
  return token === LATEST_RESUME ? null : 'gone';
}

export function loadFinished(): FinishedGame | null {
  const g = readJson<FinishedGame>('last');
  if (!g || g.v !== 1 || !isFen(g.startFen) || !isStringArray(g.moves) || !g.result) return null;
  if (g.mySides !== undefined && !isSideArray(g.mySides)) return null;
  return g;
}

export function saveFinished(g: Omit<FinishedGame, 'v'>): void {
  writeJson('last', { v: 1, ...g });
}

export interface AiPrefs {
  level: LevelId;
  side: Side | 'r';
}

export function loadAiPrefs(fallback: AiPrefs): AiPrefs {
  const p = readJson<AiPrefs>('aiPrefs');
  const levelOk = p && Number.isInteger(p.level) && p.level >= 1 && p.level <= 5;
  const sideOk = p && (p.side === 0 || p.side === 1 || p.side === 'r');
  return { level: levelOk ? p.level : fallback.level, side: sideOk ? p.side : fallback.side };
}

export function saveAiPrefs(p: AiPrefs): void {
  writeJson('aiPrefs', p);
}
