import { describe, expect, it } from 'vitest';
import { sqToRowCol } from '../../src/engine/bitboard.ts';
import type { Side } from '../../src/engine/types.ts';
import { fromScreen, keyAction, startCursor, stepCursor, toScreen } from '../../src/game/keyboard.ts';

const sq = (pdn: number) => pdn - 1;
const pdn = (s: number) => s + 1;

describe('screen mapping', () => {
  it('puts each side’s single corner at the viewer’s near-left', () => {
    expect(toScreen(sq(4), 0)).toEqual({ r: 7, c: 0 });
    expect(toScreen(sq(29), 1)).toEqual({ r: 7, c: 0 });
  });

  it('puts the double corner at the viewer’s near-right', () => {
    expect(toScreen(sq(1), 0)).toEqual({ r: 7, c: 6 });
    expect(toScreen(sq(32), 1)).toEqual({ r: 7, c: 6 });
    expect(toScreen(sq(5), 0)).toEqual({ r: 6, c: 7 });
  });

  it('round-trips every square in both orientations onto dark cells', () => {
    for (const side of [0, 1] as Side[]) {
      for (let s = 0; s < 32; s++) {
        const cell = toScreen(s, side);
        expect((cell.r + cell.c) % 2).toBe(1);
        expect(fromScreen(cell, side)).toBe(s);
      }
    }
    expect(fromScreen({ r: 0, c: 0 }, 0)).toBeNull();
    expect(fromScreen({ r: -1, c: 1 }, 0)).toBeNull();
  });
});

describe('cursor movement', () => {
  it('moves up the screen toward the opponent for side 0', () => {
    const next = stepCursor(sq(10), 'up', 0);
    expect(sqToRowCol(next).row).toBe(sqToRowCol(sq(10)).row + 1);
    expect([14, 15]).toContain(pdn(next));
  });

  it('moves up the screen toward lower squares for side 1', () => {
    const next = stepCursor(sq(23), 'up', 1);
    expect(sqToRowCol(next).row).toBe(sqToRowCol(sq(23)).row - 1);
  });

  it('left and right are mirrored between orientations', () => {
    const left0 = stepCursor(sq(14), 'left', 0);
    const left1 = stepCursor(sq(14), 'left', 1);
    expect(toScreen(left0, 0).c).toBe(toScreen(sq(14), 0).c - 2);
    expect(toScreen(left1, 1).c).toBe(toScreen(sq(14), 1).c - 2);
    expect(sqToRowCol(left0).col).toBe(sqToRowCol(sq(14)).col + 2);
    expect(sqToRowCol(left1).col).toBe(sqToRowCol(sq(14)).col - 2);
  });

  it('stays put at the board edges', () => {
    expect(stepCursor(sq(4), 'left', 0)).toBe(sq(4));
    expect(stepCursor(sq(4), 'down', 0)).toBe(sq(4));
    expect(stepCursor(sq(29), 'up', 0)).toBe(sq(29));
  });

  it('zig-zags up and down without leaving a two-column band', () => {
    let cur = sq(1);
    const cols = new Set<number>();
    for (let i = 0; i < 7; i++) {
      cur = stepCursor(cur, 'up', 0);
      cols.add(toScreen(cur, 0).c);
    }
    expect(toScreen(cur, 0).r).toBe(0);
    expect(cols.size).toBeLessThanOrEqual(2);
    for (let i = 0; i < 7; i++) cur = stepCursor(cur, 'down', 0);
    expect(toScreen(cur, 0).r).toBe(7);
  });

  it('starts on the preferred piece nearest the viewer', () => {
    expect(startCursor([sq(9), sq(12), sq(22)], 0)).toBe(sq(9));
    expect(startCursor([sq(9), sq(22)], 1)).toBe(sq(22));
    expect(startCursor([], 0)).not.toBeNull();
  });
});

describe('keyAction', () => {
  const k = (key: string, mods: Partial<KeyboardEvent> = {}) =>
    keyAction({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods } as KeyboardEvent);

  it('maps arrows, activation and shortcuts', () => {
    expect(k('ArrowUp')).toEqual({ kind: 'cursor', dir: 'up' });
    expect(k('ArrowLeft')).toEqual({ kind: 'cursor', dir: 'left' });
    expect(k('Enter')).toEqual({ kind: 'activate' });
    expect(k(' ')).toEqual({ kind: 'activate' });
    expect(k('Escape')).toEqual({ kind: 'cancel' });
    expect(k('u')).toEqual({ kind: 'undo' });
    expect(k('F')).toEqual({ kind: 'flip' });
    expect(k('m')).toEqual({ kind: 'mute' });
  });

  it('ignores modified and unrelated keys', () => {
    expect(k('u', { ctrlKey: true })).toBeNull();
    expect(k('ArrowUp', { metaKey: true })).toBeNull();
    expect(k('x')).toBeNull();
  });
});
