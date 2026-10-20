import { describe, expect, it } from 'vitest';
import {
  MoveList,
  applyMove,
  genMoves,
  legalMoves,
  makeInto,
  newSearchPosition,
  toSearchPosition,
} from '../../src/engine/movegen.ts';
import { flip, fromFen, initialPosition } from '../../src/engine/position.ts';
import { Rng, mixSeed, mulberry32 } from '../../src/engine/rng.ts';
import { hashOf } from '../../src/engine/zobrist.ts';
import { randomGamePositions } from './randomGames.ts';

describe('zobrist hashing', () => {
  it('is deterministic and distinguishes side to move', () => {
    const p = initialPosition();
    expect(hashOf(p)).toEqual(hashOf(fromFen('B:W21-32:B1-12')));
    expect(hashOf(p)).not.toEqual(hashOf({ ...p, turn: 1 }));
    expect(hashOf(p)).not.toEqual(hashOf(flip(p)));
    for (const half of hashOf(p)) expect(half).toBe(half >>> 0);
  });

  it('incremental make matches full hash, applyMove and the no-progress counter', () => {
    const list = new MoveList(8);
    const src = newSearchPosition();
    const dst = newSearchPosition();
    let children = 0;
    for (const p of randomGamePositions(42, 120)) {
      toSearchPosition(p, 5, src);
      const n = genMoves(src, list);
      const objects = legalMoves(p);
      expect(n).toBe(objects.length);
      for (let i = 0; i < n; i++) {
        expect(list.move(i)).toEqual(objects[i]);
        makeInto(dst, src, list, i);
        const expected = applyMove(p, objects[i]);
        expect({ black: dst.black, white: dst.white, kings: dst.kings, turn: dst.turn }).toEqual(expected);
        expect([dst.hi, dst.lo]).toEqual(hashOf(expected));
        const irreversible = objects[i].captured !== 0 || ((p.kings >>> objects[i].from) & 1) === 0;
        expect(dst.quiet).toBe(irreversible ? 0 : 6);
        expect(list.isIrreversible(i)).toBe(irreversible);
        children++;
      }
    }
    expect(children).toBeGreaterThan(10_000);
  });

  it('keeps hashes consistent across king loop captures', () => {
    const p = fromFen('B:WK10,11,18,K19:BK14');
    const list = new MoveList();
    const src = toSearchPosition(p);
    const dst = newSearchPosition();
    expect(genMoves(src, list)).toBe(2);
    makeInto(dst, src, list, 0);
    expect([dst.hi, dst.lo]).toEqual(hashOf(applyMove(p, list.move(0))));
  });
});

describe('MoveList', () => {
  it('grows past its initial capacity', () => {
    const list = new MoveList(1);
    const p = fromFen('B:W1:BK13,K14,K15,K16,K17,K18,K19,K20');
    expect(genMoves(p, list)).toBe(legalMoves(p).length);
    expect(list.count).toBeGreaterThan(8);
    expect(Array.from({ length: list.count }, (_, i) => list.move(i))).toEqual(legalMoves(p));
  });
});

describe('rng', () => {
  it('is reproducible and resumable from state', () => {
    const a = new Rng(123);
    const first = [a.nextU32(), a.nextU32()];
    const resumed = new Rng(0);
    resumed.state = a.state;
    expect(resumed.next()).toBe(a.next());
    const b = new Rng(123);
    expect([b.nextU32(), b.nextU32()]).toEqual(first);
  });

  it('produces floats in [0, 1) and bounded ints', () => {
    const r = mulberry32(9);
    const rng = new Rng(9);
    for (let i = 0; i < 1000; i++) {
      const x = r();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      const k = rng.int(7);
      expect(Number.isInteger(k) && k >= 0 && k < 7).toBe(true);
    }
  });

  it('mixes seeds into distinct uint32 values', () => {
    expect(mixSeed(1, 2)).not.toBe(mixSeed(2, 1));
    expect(mixSeed(1, 2)).toBe(mixSeed(1, 2));
    expect(mixSeed(0)).toBe(mixSeed(0) >>> 0);
  });
});
