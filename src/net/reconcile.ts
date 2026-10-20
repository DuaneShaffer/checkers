import type { GameResult, OnlineGame, Role } from './protocol.ts';
import { engineResult, isLegalLine } from './rules.ts';

export type LineRelation = 'equal' | 'prefix' | 'behind' | 'diverged';

export type ReconcileOutcome =
  | { kind: 'equal' }
  | { kind: 'adopt'; relation: 'prefix' | 'diverged' | 'equal'; game: OnlineGame }
  | { kind: 'push'; relation: 'behind' | 'diverged' }
  | { kind: 'invalid' };

export function compareLines(local: readonly string[], remote: readonly string[]): LineRelation {
  const shared = Math.min(local.length, remote.length);
  for (let i = 0; i < shared; i++) if (local[i] !== remote[i]) return 'diverged';
  if (local.length === remote.length) return 'equal';
  return local.length < remote.length ? 'prefix' : 'behind';
}

export function sameResult(a: GameResult | undefined, b: GameResult | undefined): boolean {
  return a === b || (!!a && !!b && a.winner === b.winner && a.reason === b.reason);
}

export function settledResult(moves: readonly string[], claimed: GameResult | undefined): GameResult | undefined {
  const derived = engineResult(moves);
  if (derived) return derived;
  if (claimed?.reason === 'resign' && claimed.winner !== null) return claimed;
  if (claimed?.reason === 'agreement' && claimed.winner === null) return claimed;
  return undefined;
}

function validated(remote: OnlineGame): OnlineGame | null {
  if (!isLegalLine(remote.moves)) return null;
  const result = settledResult(remote.moves, remote.result);
  return { id: remote.id, hostSide: remote.hostSide, moves: [...remote.moves], ...(result ? { result } : {}) };
}

function adopt(remote: OnlineGame, relation: 'prefix' | 'diverged' | 'equal'): ReconcileOutcome {
  const game = validated(remote);
  return game ? { kind: 'adopt', relation, game } : { kind: 'invalid' };
}

function hostWins(remote: OnlineGame, role: Role): ReconcileOutcome {
  return role === 'guest' ? adopt(remote, 'diverged') : { kind: 'push', relation: 'diverged' };
}

export function reconcile(local: OnlineGame | null, remote: OnlineGame | null, role: Role): ReconcileOutcome {
  if (!remote) return local ? { kind: 'push', relation: 'behind' } : { kind: 'equal' };
  if (!local) return adopt(remote, 'prefix');
  if (local.id !== remote.id || local.hostSide !== remote.hostSide) return hostWins(remote, role);

  switch (compareLines(local.moves, remote.moves)) {
    case 'prefix':
      return adopt(remote, 'prefix');
    case 'behind':
      return { kind: 'push', relation: 'behind' };
    case 'diverged':
      return hostWins(remote, role);
    case 'equal':
      break;
  }
  const remoteResult = settledResult(remote.moves, remote.result);
  if (sameResult(local.result, remoteResult)) return { kind: 'equal' };
  if (!local.result) return adopt(remote, 'equal');
  if (!remoteResult) return { kind: 'push', relation: 'behind' };
  return hostWins(remote, role);
}
