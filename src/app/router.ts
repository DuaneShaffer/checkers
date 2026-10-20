import type { LevelId } from '../ai/levels.ts';
import type { Side } from '../engine/types.ts';
import type { RouteParams } from './contracts.ts';
import { isValidFen } from '../engine/position.ts';

export type RouteName = 'home' | 'ai' | 'local' | 'friend' | 'join' | 'answer' | 'play' | 'lab' | 'review';

export interface Route {
  name: RouteName;
  params: RouteParams;
}

const ARITY: Record<Exclude<RouteName, 'home' | 'lab'>, number> = {
  ai: 1,
  local: 1,
  friend: 1,
  review: 1,
  join: 2,
  answer: 2,
  play: 2,
};

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '').replace(/^\/+/, '');
  const q = raw.indexOf('?');
  const pathPart = q >= 0 ? raw.slice(0, q) : raw;
  const query = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '');
  const path = pathPart.split('/').filter(Boolean).map(safeDecode);
  const params = { path, query };
  const head = path[0];
  if (head === undefined) return { name: 'home', params };
  if (head === 'lab') return { name: 'lab', params };
  if (Object.hasOwn(ARITY, head) && path.length === ARITY[head as keyof typeof ARITY]) return { name: head as RouteName, params };
  return { name: 'home', params: { path: [], query: new URLSearchParams() } };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function formatHash(path: readonly string[], query?: Record<string, string | number | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== null && v !== undefined && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return `#/${path.map(encodeURIComponent).join('/')}${s ? `?${s}` : ''}`;
}

export type SideChoice = Side | 'r';

export interface AiRouteOptions {
  level: LevelId;
  side: SideChoice;
  gen: number | null;
  fen: string | null;
  resume: string | null;
}

export const DEFAULT_AI_LEVEL: LevelId = 2;

export function parseAiParams(query: URLSearchParams): AiRouteOptions {
  const level = Number(query.get('level'));
  const side = query.get('side');
  const gen = query.get('gen');
  const genNum = gen !== null && /^\d+$/.test(gen) ? Number(gen) : null;
  return {
    level: Number.isInteger(level) && level >= 1 && level <= 5 ? (level as LevelId) : DEFAULT_AI_LEVEL,
    side: side === '1' ? 1 : side === 'r' ? 'r' : 0,
    gen: genNum,
    fen: validFen(query.get('fen')),
    resume: query.get('resume') || null,
  };
}

function validFen(fen: string | null): string | null {
  return isValidFen(fen) ? fen : null;
}

export function aiHash(o: Partial<AiRouteOptions>): string {
  return formatHash(['ai'], {
    level: o.level,
    side: o.side,
    gen: o.gen,
    fen: o.fen,
    resume: o.resume,
  });
}

export interface HashRouter {
  current(): Route;
  start(): void;
  navigate(hash: string): void;
  dispose(): void;
}

export function createHashRouter(onRoute: (route: Route) => void): HashRouter {
  const handler = () => onRoute(parseHash(location.hash));
  return {
    current: () => parseHash(location.hash),
    start() {
      window.addEventListener('hashchange', handler);
      handler();
    },
    navigate(hash) {
      const target = hash.startsWith('#') ? hash : `#${hash}`;
      if (location.hash === target || (target === '#/' && location.hash === '')) handler();
      else location.hash = target;
    },
    dispose() {
      window.removeEventListener('hashchange', handler);
    },
  };
}
