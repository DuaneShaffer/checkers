import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LATEST_RESUME, findResume, saveResume } from '../../src/app/persist.ts';
import { aiHash, formatHash, parseAiParams, parseHash } from '../../src/app/router.ts';

describe('parseHash', () => {
  it('maps empty and root hashes to home', () => {
    for (const h of ['', '#', '#/', '#//']) expect(parseHash(h).name).toBe('home');
  });

  it('parses every app route', () => {
    expect(parseHash('#/ai?level=4&side=1').name).toBe('ai');
    expect(parseHash('#/local').name).toBe('local');
    expect(parseHash('#/friend').name).toBe('friend');
    expect(parseHash('#/review').name).toBe('review');
    expect(parseHash('#/join/abc-DEF_123').params.path).toEqual(['join', 'abc-DEF_123']);
    expect(parseHash('#/answer/xyz').name).toBe('answer');
    expect(parseHash('#/play/ABCDE12345').params.path).toEqual(['play', 'ABCDE12345']);
  });

  it('passes every lab sub-route through to the lab', () => {
    expect(parseHash('#/lab').name).toBe('lab');
    expect(parseHash('#/lab/12').params.path).toEqual(['lab', '12']);
    const replay = parseHash('#/lab/12/g12-s3?ply=40');
    expect(replay.name).toBe('lab');
    expect(replay.params.path).toEqual(['lab', '12', 'g12-s3']);
    expect(replay.params.query.get('ply')).toBe('40');
    expect(parseHash('#/lab/live/3/40').params.path).toEqual(['lab', 'live', '3', '40']);
  });

  it('falls back to home for unknown or malformed routes', () => {
    expect(parseHash('#/nope').name).toBe('home');
    expect(parseHash('#/join').name).toBe('home');
    expect(parseHash('#/play/A/B').name).toBe('home');
    expect(parseHash('#/toString').name).toBe('home');
    expect(parseHash('#/constructor').name).toBe('home');
  });

  it('decodes percent-encoded segments', () => {
    expect(parseHash('#/join/a%2Fb').params.path).toEqual(['join', 'a/b']);
    expect(parseHash('#/join/%E0%A4%A').params.path).toEqual(['join', '%E0%A4%A']);
  });
});

describe('AI route options', () => {
  it('uses defaults for missing or invalid values', () => {
    const o = parseAiParams(new URLSearchParams('level=9&side=x&gen=abc&fen=garbage'));
    expect(o).toEqual({ level: 2, side: 0, gen: null, fen: null, resume: null });
  });

  it('reads level, side, generation, FEN and resume', () => {
    const fen = 'W:W21,22:B5,K9';
    const o = parseAiParams(new URLSearchParams({ level: '5', side: '1', gen: '40', fen, resume: 'g1abc' }));
    expect(o).toEqual({ level: 5, side: 1, gen: 40, fen, resume: 'g1abc' });
    expect(parseAiParams(new URLSearchParams('side=r')).side).toBe('r');
  });

  it('round-trips through aiHash', () => {
    const fen = 'B:W18,26,27:B15';
    const hash = aiHash({ level: 3, side: 'r', gen: 7, fen });
    const route = parseHash(hash);
    expect(route.name).toBe('ai');
    expect(parseAiParams(route.params.query)).toEqual({ level: 3, side: 'r', gen: 7, fen, resume: null });
  });

  it('formats hashes without empty parameters', () => {
    expect(formatHash(['local'])).toBe('#/local');
    expect(formatHash(['ai'], { level: 1, gen: null, fen: '' })).toBe('#/ai?level=1');
    expect(aiHash({ resume: '1' })).toBe('#/ai?resume=1');
  });
});

describe('resume links', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const save = (id: string) => saveResume({ mode: 'ai', id, startFen: 'B:W21,22:B9,10', moves: ['9-13'], humanSide: 0, level: 1, gen: null });

  it('restores only the game the link names', () => {
    save('game-b');
    expect(findResume('game-b', 'ai')).toMatchObject({ id: 'game-b', level: 1 });
    expect(findResume('game-a', 'ai')).toBe('gone');
    expect(findResume('game-b', 'local')).toBe('gone');
  });

  it('treats the generic token as whatever game is saved', () => {
    expect(findResume(LATEST_RESUME, 'ai')).toBeNull();
    save('game-b');
    expect(findResume(LATEST_RESUME, 'ai')).toMatchObject({ id: 'game-b' });
    expect(findResume(LATEST_RESUME, 'local')).toBeNull();
    expect(findResume(null, 'ai')).toBeNull();
  });

  it('reports a finished or discarded game as gone', () => {
    expect(findResume('game-a', 'ai')).toBe('gone');
  });
});
