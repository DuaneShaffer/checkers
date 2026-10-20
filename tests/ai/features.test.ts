import { describe, expect, it } from 'vitest';
import { flip, fromFen, initialPosition } from '../../src/engine/position.ts';
import type { Position } from '../../src/engine/types.ts';
import { INPUTS, MAX_ACTIVE, OPP_KINGS, OPP_MEN, OWN_KINGS, OWN_MEN, encode, encodeDense } from '../../src/ai/features.ts';
import { randomPositions } from './helpers.ts';

function features(p: Position): { active: number[]; extras: number[] } {
  const active = new Int32Array(MAX_ACTIVE);
  const extras = new Float32Array(4);
  const n = encode(p, active, extras);
  return { active: Array.from(active.subarray(0, n)).sort((a, b) => a - b), extras: Array.from(extras) };
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, i) => from + i);

describe('features', () => {
  it('encodes the initial position from the side to move', () => {
    const { active, extras } = features(initialPosition());
    expect(active).toEqual([...range(OWN_MEN, OWN_MEN + 12), ...range(OPP_MEN + 20, OPP_MEN + 32)]);
    expect(extras).toEqual([0, 0, 1, 0]);
  });

  it('views White to move as if White were Black', () => {
    const white = features(fromFen('W:W21,K32:B1'));
    expect(white.active).toEqual([OWN_MEN + 11, OWN_KINGS + 0, OPP_MEN + 31]);
    expect(white.extras[0]).toBeCloseTo(0);
    expect(white.extras[1]).toBeCloseTo(1 / 12);
    expect(white.extras[2]).toBeCloseTo(3 / 24);
  });

  it('flags when the opponent would have a capture', () => {
    expect(features(fromFen('B:W18:B14')).extras[3]).toBe(1);
    expect(features(fromFen('B:W18:B5')).extras[3]).toBe(0);
    expect(features(fromFen('W:W18:B14')).extras[3]).toBe(1);
    expect(features(fromFen('W:WK10:BK14')).extras[3]).toBe(1);
  });

  it('is identical for a position and its colour-swapped 180° rotation', () => {
    for (const p of randomPositions(11, 400)) {
      expect(features(flip(p))).toEqual(features(p));
    }
  });

  it('gives different features to positions that differ only in side to move', () => {
    const p = fromFen('B:W21,22:B9,10,11');
    expect(features({ ...p, turn: 1 })).not.toEqual(features(p));
  });

  it('dense encoding matches the sparse one', () => {
    for (const p of randomPositions(12, 50)) {
      const { active, extras } = features(p);
      const dense = encodeDense(p);
      expect(dense.length).toBe(INPUTS);
      const ones = Array.from(dense.subarray(0, 128)).flatMap((v, i) => (v === 1 ? [i] : []));
      expect(ones).toEqual(active);
      expect(Array.from(dense.subarray(128))).toEqual(extras);
      expect(active.every((i) => i < OPP_KINGS + 32)).toBe(true);
    }
  });
});
