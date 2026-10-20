import { describe, expect, it } from 'vitest';
import { legalMoves } from '../../src/engine/movegen.ts';
import { moveToString } from '../../src/engine/notation.ts';
import { fromFen, initialPosition } from '../../src/engine/position.ts';
import {
  type SelectionState,
  cancelSelection,
  createSelection,
  jumpedBetween,
  selectionView,
  tapSquare,
} from '../../src/game/selection.ts';

const sq = (pdn: number) => pdn - 1;

function fromPosition(fen?: string): SelectionState {
  const pos = fen ? fromFen(fen) : initialPosition();
  return createSelection(pos, legalMoves(pos));
}

function taps(s: SelectionState, ...pdns: (number | null)[]) {
  let state = s;
  let effect = null as ReturnType<typeof tapSquare>['effect'] | null;
  for (const p of pdns) ({ state, effect } = tapSquare(state, p === null ? null : sq(p)));
  return { state, effect: effect! };
}

describe('selection: quiet moves', () => {
  it('lists the movable pieces of the opening position', () => {
    const v = selectionView(fromPosition());
    expect(v.movable.map((s) => s + 1).sort((a, b) => a - b)).toEqual([9, 10, 11, 12]);
    expect(v.selected).toBeNull();
    expect(v.captureRequired).toBe(false);
  });

  it('selects a piece and shows its quiet targets', () => {
    const { state, effect } = taps(fromPosition(), 11);
    expect(effect).toEqual({ kind: 'select', from: sq(11) });
    const v = selectionView(state);
    expect(v.selected).toBe(sq(11));
    expect(v.targets.map((s) => s + 1).sort((a, b) => a - b)).toEqual([15, 16]);
    expect(v.captureTargets).toEqual([]);
  });

  it('commits only when a full path is chosen', () => {
    const { state, effect } = taps(fromPosition(), 11, 15);
    expect(effect.kind).toBe('commit');
    if (effect.kind === 'commit') {
      expect(moveToString(effect.move)).toBe('11-15');
      expect(effect.previewedHops).toBe(0);
    }
    expect(state.prefix).toEqual([]);
  });

  it('deselects when the selected piece is tapped again or the tap misses the board', () => {
    expect(taps(fromPosition(), 11, 11).effect).toEqual({ kind: 'deselect', revertHops: 0 });
    expect(taps(fromPosition(), 11, null).effect).toEqual({ kind: 'deselect', revertHops: 0 });
  });

  it('switches selection to another movable piece', () => {
    const { state, effect } = taps(fromPosition(), 11, 9);
    expect(effect).toEqual({ kind: 'select', from: sq(9) });
    expect(selectionView(state).selected).toBe(sq(9));
  });

  it('flags own blocked pieces and ignores opponent pieces and empty squares while idle', () => {
    expect(taps(fromPosition(), 1).effect).toEqual({ kind: 'illegal', reason: 'blocked' });
    expect(taps(fromPosition(), 22).effect).toEqual({ kind: 'none' });
    expect(taps(fromPosition(), 17).effect).toEqual({ kind: 'none' });
  });

  it('rejects a non-target square while a piece is selected', () => {
    const { state, effect } = taps(fromPosition(), 11, 18);
    expect(effect).toEqual({ kind: 'illegal', reason: 'not-a-target' });
    expect(selectionView(state).selected).toBe(sq(11));
  });
});

describe('selection: captures and multi-jumps', () => {
  it('reports capture-required when tapping a piece that cannot jump', () => {
    const s = fromPosition('B:W14,22,23:B10,1');
    expect(selectionView(s).captureRequired).toBe(true);
    expect(selectionView(s).movable).toEqual([sq(10)]);
    expect(taps(s, 1).effect).toEqual({ kind: 'illegal', reason: 'capture-required' });
  });

  it('auto-advances through an unambiguous double jump and commits', () => {
    const s = fromPosition('B:W14,22,23:B10');
    const sel = taps(s, 10);
    expect(selectionView(sel.state).captureTargets).toEqual([sq(17)]);
    const { effect } = tapSquare(sel.state, sq(17));
    expect(effect.kind).toBe('commit');
    if (effect.kind === 'commit') expect(moveToString(effect.move)).toBe('10x17x26');
  });

  it('stops at a branch point and lets the player choose the continuation', () => {
    const s = fromPosition('B:W14,15,22,23,24:B10');
    const { state, effect } = taps(s, 10, 19);
    expect(effect).toEqual({ kind: 'advance', hops: [{ from: sq(10), to: sq(19), captured: sq(15) }] });
    const v = selectionView(state);
    expect(v.current).toBe(sq(19));
    expect(v.captureTargets.map((x) => x + 1).sort((a, b) => a - b)).toEqual([26, 28]);
    expect(v.pending).toEqual([sq(15)]);
    expect(v.movable).toEqual([]);

    const done = tapSquare(state, sq(28));
    expect(done.effect.kind).toBe('commit');
    if (done.effect.kind === 'commit') {
      expect(moveToString(done.effect.move)).toBe('10x19x28');
      expect(done.effect.previewedHops).toBe(1);
    }
  });

  it('distinguishes paths that share their final landing square', () => {
    const s = fromPosition('B:W14,15,22,23,24:B10');
    const viaLeft = taps(s, 10, 17).effect;
    expect(viaLeft.kind === 'commit' && moveToString(viaLeft.move)).toBe('10x17x26');
    const viaRight = taps(s, 10, 19, 26).effect;
    expect(viaRight.kind === 'commit' && moveToString(viaRight.move)).toBe('10x19x26');
  });

  it('auto-advances several shared hops before a branch', () => {
    const s = fromPosition('B:W6,15,23,24:B1');
    const { state, effect } = taps(s, 1, 10);
    expect(effect).toEqual({
      kind: 'advance',
      hops: [
        { from: sq(1), to: sq(10), captured: sq(6) },
        { from: sq(10), to: sq(19), captured: sq(15) },
      ],
    });
    expect(state.prefix).toEqual([sq(1), sq(10), sq(19)]);
    const done = tapSquare(state, sq(26));
    expect(done.effect.kind === 'commit' && moveToString(done.effect.move)).toBe('1x10x19x26');
    expect(done.effect.kind === 'commit' && done.effect.previewedHops).toBe(2);
  });

  it('reverts previewed hops when cancelled or when the moving piece is tapped', () => {
    const s = fromPosition('B:W6,15,23,24:B1');
    const mid = taps(s, 1, 10).state;
    expect(cancelSelection(mid).effect).toEqual({ kind: 'deselect', revertHops: 2 });
    expect(tapSquare(mid, sq(19)).effect).toEqual({ kind: 'deselect', revertHops: 2 });
    expect(tapSquare(mid, sq(1)).effect).toEqual({ kind: 'illegal', reason: 'not-a-target' });
    expect(tapSquare(mid, null).state.prefix).toEqual([]);
  });

  it('does not allow switching pieces mid-sequence', () => {
    const s = fromPosition('B:W6,15,23,24,14:B1,9');
    expect(selectionView(s).movable.sort((a, b) => a - b)).toEqual([sq(1), sq(9)]);
    const { state: mid, effect } = taps(s, 1, 10);
    expect(effect.kind).toBe('advance');
    expect(tapSquare(mid, sq(9)).effect).toEqual({ kind: 'illegal', reason: 'not-a-target' });
  });

  it('commits a jump that ends on promotion', () => {
    const { effect } = taps(fromPosition('B:W18,26,27:B15'), 15, 22);
    expect(effect.kind === 'commit' && moveToString(effect.move)).toBe('15x22x31');
    expect(effect.kind === 'commit' && effect.move.promotes).toBe(true);
  });

  it('finds the jumped square between two landings', () => {
    expect(jumpedBetween(sq(10), sq(19))).toBe(sq(15));
    expect(jumpedBetween(sq(11), sq(15))).toBeNull();
  });
});
