import { describe, expect, it } from 'vitest';
import type { WireMsg } from '../../src/net/protocol.ts';
import { cleanName, decodeWire, encodeWire } from '../../src/net/wire.ts';

const VALID: WireMsg[] = [
  { t: 'hello', proto: 1, clientId: 'c0ffee00-1234-4abc-8def-0123456789ab', role: 'guest', name: 'Ann' },
  { t: 'reject', reason: 'room-full' },
  { t: 'sync', game: null },
  { t: 'sync', game: { id: '0.ab', hostSide: 1, moves: ['11-15', '23-19'], result: { winner: null, reason: 'agreement' } }, offer: { kind: 'rematch', gameId: '0.ab', ply: 2, from: 'host' } },
  { t: 'start', game: { id: '1.cd', hostSide: 0 } },
  { t: 'move', gameId: '0.ab', ply: 3, move: '15x24x31', hash: 'deadbeef' },
  { t: 'resign', gameId: '0.ab', ply: 0 },
  { t: 'offer', kind: 'draw', gameId: '0.ab', ply: 12 },
  { t: 'answer', kind: 'draw', gameId: '0.ab', ply: 12, accept: false },
  { t: 'ping', n: 4, ply: 2, hash: 'a1' },
  { t: 'pong', n: 4, ply: 2, hash: 'a1' },
  { t: 'ice-restart', kind: 'offer', sdp: 'v=0\r\n' },
  { t: 'bye' },
];

describe('wire codec', () => {
  it.each(VALID.map((m) => [m.t, m] as const))('round-trips %s', (_t, msg) => {
    expect(decodeWire(encodeWire(msg))).toEqual(msg);
  });

  it('drops unknown fields', () => {
    expect(decodeWire(JSON.stringify({ t: 'bye', extra: 1 }))).toEqual({ t: 'bye' });
    expect(decodeWire(JSON.stringify({ t: 'start', game: { id: 'x', hostSide: 0, evil: true } }))).toEqual({ t: 'start', game: { id: 'x', hostSide: 0 } });
  });

  it.each([
    ['not json', '{'],
    ['array', '[]'],
    ['number', 42],
    ['unknown type', JSON.stringify({ t: 'emote', id: 1 })],
    ['bad role', JSON.stringify({ t: 'hello', proto: 1, clientId: 'abc', role: 'king' })],
    ['bad move text', JSON.stringify({ t: 'move', gameId: 'g', ply: 0, move: '<script>', hash: '1' })],
    ['negative ply', JSON.stringify({ t: 'move', gameId: 'g', ply: -1, move: '11-15', hash: '1' })],
    ['fractional n', JSON.stringify({ t: 'ping', n: 1.5, ply: 0, hash: '1' })],
    ['bad hash', JSON.stringify({ t: 'ping', n: 1, ply: 0, hash: 'XYZ' })],
    ['bad side', JSON.stringify({ t: 'start', game: { id: 'g', hostSide: 2 } })],
    ['bad game moves', JSON.stringify({ t: 'sync', game: { id: 'g', hostSide: 0, moves: [1] } })],
    ['bad result', JSON.stringify({ t: 'sync', game: { id: 'g', hostSide: 0, moves: [], result: { winner: 0, reason: 'timeout' } } })],
    ['bad offer', JSON.stringify({ t: 'sync', game: null, offer: { kind: 'takeback', gameId: 'g', ply: 0, from: 'host' } })],
    ['missing accept', JSON.stringify({ t: 'answer', kind: 'draw', gameId: 'g', ply: 0 })],
    ['oversize', JSON.stringify({ t: 'bye', pad: 'x'.repeat(70_000) })],
  ])('rejects %s', (_name, raw) => {
    expect(decodeWire(raw)).toBeNull();
  });

  it('sanitizes names in hello', () => {
    const msg = decodeWire(JSON.stringify({ t: 'hello', proto: 1, clientId: 'abc', role: 'host', name: '‮Eve\u0000   Smith' }));
    expect(msg).toEqual({ t: 'hello', proto: 1, clientId: 'abc', role: 'host', name: 'Eve Smith' });
    expect(cleanName('   ')).toBeUndefined();
    expect(cleanName(5)).toBeUndefined();
  });

  it('decodes hellos from other protocol versions so they can be rejected', () => {
    expect(decodeWire(JSON.stringify({ t: 'hello', proto: 2, clientId: 'abc', role: 'host' }))).toMatchObject({ proto: 2 });
  });
});
