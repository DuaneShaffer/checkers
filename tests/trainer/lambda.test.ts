import { describe, expect, it } from 'vitest';
import { evalToSide0Hundredths, lambdaTargets } from '../../trainer/selfplay.ts';
import { lambdaFor, learningRate } from '../../trainer/nn-train.ts';

const close = (actual: number[], expected: number[]): void => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 12));
};

describe('lambdaTargets', () => {
  it('blends the next value with the return (two plies, λ = 0.5)', () => {
    close(lambdaTargets([0.2, 0.4], [false, false], 1, 0.5), [0.7, 1]);
  });

  it('matches the closed-form λ-return over three plies', () => {
    const lambda = 0.5;
    const J = [0, 0.4, 0.8];
    const z = 1;
    const g0 = (1 - lambda) * (J[1] + lambda * J[2]) + lambda * lambda * z;
    close(lambdaTargets(J, [false, false, false], z, lambda), [g0, 0.9, 1]);
    expect(g0).toBeCloseTo(0.65, 12);
  });

  it('reduces to TD(0) at λ = 0', () => {
    close(lambdaTargets([0.1, 0.2, 0.3], [false, false, false], -1, 0), [0.2, 0.3, -1]);
  });

  it('reduces to Monte Carlo returns at λ = 1', () => {
    close(lambdaTargets([0.1, -0.6, 0.3, 0.9], [false, false, false, false], -1, 1), [-1, -1, -1, -1]);
  });

  it('cuts the trace at an exploratory move', () => {
    close(lambdaTargets([0.1, 0.5, -0.2], [false, true, false], 1, 0.5), [0.5, 0.5, 1]);
  });

  it('gives an exploratory final ply its own value instead of the result', () => {
    close(lambdaTargets([0.3, -0.4], [false, true], 1, 0.7), [-0.4, -0.4]);
  });

  it('handles a draw with all values zero', () => {
    close(lambdaTargets([0, 0, 0], [false, false, false], 0, 0.7), [0, 0, 0]);
  });

  it('is empty for an empty game', () => {
    expect(lambdaTargets([], [], 1, 0.7)).toEqual([]);
  });
});

describe('schedules', () => {
  it('uses λ 0.9 early, 0.7 later, unless overridden', () => {
    expect(lambdaFor(0, null)).toBe(0.9);
    expect(lambdaFor(9, null)).toBe(0.9);
    expect(lambdaFor(10, null)).toBe(0.7);
    expect(lambdaFor(3, 0.5)).toBe(0.5);
  });

  it('halves the learning rate at gen 100 and again at 200', () => {
    expect(learningRate(0, 1e-3)).toBe(1e-3);
    expect(learningRate(100, 1e-3)).toBe(5e-4);
    expect(learningRate(250, 1e-3)).toBe(2.5e-4);
  });
});

describe('evalToSide0Hundredths', () => {
  it('scales ±1000 scores to ±100 from Black’s view', () => {
    expect(evalToSide0Hundredths(500, 0)).toBe(50);
    expect(evalToSide0Hundredths(500, 1)).toBe(-50);
    expect(evalToSide0Hundredths(0, 1)).toBe(0);
    expect(Object.is(evalToSide0Hundredths(0, 1), -0)).toBe(false);
  });

  it('clamps mate scores to ±100', () => {
    expect(evalToSide0Hundredths(29990, 0)).toBe(100);
    expect(evalToSide0Hundredths(-29990, 0)).toBe(-100);
    expect(evalToSide0Hundredths(29990, 1)).toBe(-100);
  });
});
