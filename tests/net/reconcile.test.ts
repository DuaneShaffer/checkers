import { describe, expect, it } from 'vitest';
import type { OnlineGame } from '../../src/net/protocol.ts';
import { compareLines, reconcile, settledResult } from '../../src/net/reconcile.ts';

const LINE = ['11-15', '23-19', '8-11', '22-17', '11-16', '24-20'];
const game = (moves: string[], extra: Partial<OnlineGame> = {}): OnlineGame => ({ id: '0.abc', hostSide: 0, moves, ...extra });

describe('compareLines', () => {
  it('classifies the four cases', () => {
    expect(compareLines(LINE, LINE)).toBe('equal');
    expect(compareLines(LINE.slice(0, 3), LINE)).toBe('prefix');
    expect(compareLines(LINE, LINE.slice(0, 2))).toBe('behind');
    expect(compareLines(['11-15', '23-19'], ['11-15', '22-18'])).toBe('diverged');
    expect(compareLines([], [])).toBe('equal');
    expect(compareLines([], ['11-15'])).toBe('prefix');
  });
});

describe('reconcile', () => {
  it('does nothing when equal', () => {
    expect(reconcile(game(LINE), game(LINE), 'guest')).toEqual({ kind: 'equal' });
    expect(reconcile(null, null, 'host')).toEqual({ kind: 'equal' });
  });

  it('adopts a validated longer remote line (prefix)', () => {
    const out = reconcile(game(LINE.slice(0, 2)), game(LINE), 'host');
    expect(out).toEqual({ kind: 'adopt', relation: 'prefix', game: game(LINE) });
  });

  it('pushes when the remote is behind', () => {
    expect(reconcile(game(LINE), game(LINE.slice(0, 4)), 'guest')).toEqual({ kind: 'push', relation: 'behind' });
    expect(reconcile(game(LINE), null, 'guest')).toEqual({ kind: 'push', relation: 'behind' });
  });

  it('lets the host win on divergence', () => {
    const hostLine = game(['11-15', '23-19']);
    const guestLine = game(['11-15', '22-18']);
    expect(reconcile(guestLine, hostLine, 'guest')).toEqual({ kind: 'adopt', relation: 'diverged', game: hostLine });
    expect(reconcile(hostLine, guestLine, 'host')).toEqual({ kind: 'push', relation: 'diverged' });
  });

  it('lets the host win when game ids differ', () => {
    const hostGame = { id: '1.zzz', hostSide: 1 as const, moves: ['11-15'] };
    expect(reconcile(game(LINE), hostGame, 'guest')).toEqual({ kind: 'adopt', relation: 'diverged', game: hostGame });
    expect(reconcile(hostGame, game(LINE), 'host')).toEqual({ kind: 'push', relation: 'diverged' });
  });

  it('adopts a remote game when we have none', () => {
    expect(reconcile(null, game(LINE), 'guest')).toEqual({ kind: 'adopt', relation: 'prefix', game: game(LINE) });
  });

  it('rejects illegal remote lines', () => {
    expect(reconcile(game(['11-15']), game(['11-15', '11-15']), 'guest')).toEqual({ kind: 'invalid' });
    expect(reconcile(game(['11-15']), game(['11-15', '23-19', '9-14', '19-10']), 'guest').kind).toBe('invalid');
    expect(reconcile(null, game(['12-16x', '1-2']), 'guest')).toEqual({ kind: 'invalid' });
  });

  it('merges results on equal lines', () => {
    const resigned = game(LINE, { result: { winner: 1, reason: 'resign' } });
    expect(reconcile(game(LINE), resigned, 'host')).toEqual({ kind: 'adopt', relation: 'equal', game: resigned });
    expect(reconcile(resigned, game(LINE), 'guest')).toEqual({ kind: 'push', relation: 'behind' });
    const drawn = game(LINE, { result: { winner: null, reason: 'agreement' } });
    expect(reconcile(resigned, drawn, 'guest')).toEqual({ kind: 'adopt', relation: 'diverged', game: drawn });
    expect(reconcile(drawn, resigned, 'host')).toEqual({ kind: 'push', relation: 'diverged' });
  });

  it('ignores result claims the engine does not confirm', () => {
    const bogus = game(LINE, { result: { winner: 0, reason: 'no-moves' } });
    expect(reconcile(game(LINE), bogus, 'guest')).toEqual({ kind: 'equal' });
    expect(settledResult(LINE, { winner: 0, reason: 'no-moves' })).toBeUndefined();
    expect(settledResult(LINE, { winner: 0, reason: 'agreement' })).toBeUndefined();
    expect(settledResult(LINE, { winner: null, reason: 'resign' })).toBeUndefined();
    expect(settledResult(LINE, { winner: 1, reason: 'resign' })).toEqual({ winner: 1, reason: 'resign' });
  });

  it('a longer line supersedes a result on a shorter one', () => {
    const drawnEarly = game(LINE.slice(0, 4), { result: { winner: null, reason: 'agreement' } });
    expect(reconcile(drawnEarly, game(LINE), 'guest')).toEqual({ kind: 'adopt', relation: 'prefix', game: game(LINE) });
  });
});
