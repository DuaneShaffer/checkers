import { describe, expect, it } from 'vitest';
import { Game, Rng, applyMove } from '../../src/engine/index.ts';
import type { Position } from '../../src/engine/index.ts';
import { Network } from '../../src/ai/network.ts';
import { ckn1ParamCount } from '../../src/shared/formats.ts';
import { Adam, DEFAULT_TRAIN, NetTrainer } from '../../trainer/nn-train.ts';
import type { PackedSamples } from '../../trainer/selfplay.ts';

function positions(count: number, seed: number): Position[] {
  const rng = new Rng(seed);
  const out: Position[] = [];
  while (out.length < count) {
    const game = new Game();
    const plies = 4 + rng.int(70);
    for (let i = 0; i < plies && !game.status().over; i++) game.play(rng.pick(game.legalMoves()));
    if (!game.status().over) out.push(game.position);
  }
  return out;
}

function kingPosition(): Position {
  let p: Position = { black: 0x00000003, white: 0x30000000, kings: 0x30000001, turn: 1 };
  p = applyMove(p, { from: 28, to: 24, path: [28, 24], captured: 0, promotes: false });
  return p;
}

function randomParams(sizes: number[], seed: number): Float64Array {
  const rng = new Rng(seed);
  const params = new Float64Array(ckn1ParamCount(sizes));
  for (let i = 0; i < params.length; i++) params[i] = (rng.next() * 2 - 1) * 0.4;
  return params;
}

function pack(list: Position[], targets: number[]): PackedSamples {
  const boards = new Uint32Array(list.length * 4);
  list.forEach((p, i) => boards.set([p.black, p.white, p.kings, p.turn], 4 * i));
  return { boards, targets: Float32Array.from(targets) };
}

describe('NetTrainer', () => {
  it('matches Network.value in the forward pass', () => {
    const rng = new Rng(5);
    const net = Network.random([132, 64, 32, 1], () => rng.next());
    for (let i = 0; i < net.params.length; i++) net.params[i] += (rng.next() - 0.5) * 0.05;
    const trainer = new NetTrainer(net.sizes);
    for (const p of [...positions(50, 11), kingPosition()]) {
      expect(trainer.forward(net.params, p)).toBeCloseTo(net.value(p), 6);
    }
  });

  it.each([
    [[132, 6, 5, 1]],
    [[132, 7, 1]],
    [[132, 1]],
  ])('passes a central finite-difference gradient check for layers %j', (sizes) => {
    const params = randomParams(sizes, sizes.length * 31 + sizes[1]);
    const trainer = new NetTrainer(sizes);
    const samples = [...positions(6, 3), kingPosition()];
    const targets = samples.map((_, i) => Math.sin(i * 1.7) * 0.8);
    const loss = (): number => samples.reduce((sum, p, i) => sum + 0.5 * (trainer.forward(params, p) - targets[i]) ** 2, 0);

    const grad = new Float64Array(params.length);
    let analyticLoss = 0;
    samples.forEach((p, i) => (analyticLoss += trainer.forwardBackward(params, p, targets[i], grad)));
    expect(analyticLoss).toBeCloseTo(loss(), 12);

    const eps = 1e-6;
    let checked = 0;
    let worst = 0;
    for (let k = 0; k < params.length; k++) {
      const orig = params[k];
      params[k] = orig + eps;
      const up = loss();
      params[k] = orig - eps;
      const down = loss();
      params[k] = orig;
      const numeric = (up - down) / (2 * eps);
      const scale = Math.max(1e-4, Math.abs(numeric) + Math.abs(grad[k]));
      worst = Math.max(worst, Math.abs(numeric - grad[k]) / scale);
      if (grad[k] !== 0 || numeric !== 0) checked++;
    }
    expect(checked).toBeGreaterThan(20);
    expect(worst).toBeLessThan(1e-5);
  });

  it('reduces the loss on a fixed dataset with Adam', () => {
    const rng = new Rng(9);
    const net = Network.random([132, 16, 8, 1], () => rng.next());
    const list = positions(400, 21);
    const targets = list.map((p) => {
      const own = p.turn === 0 ? p.black : p.white;
      const opp = p.turn === 0 ? p.white : p.black;
      return Math.tanh((popcount(own) - popcount(opp)) / 3);
    });
    const samples = pack(list, targets);
    const trainer = new NetTrainer(net.sizes);
    const before = trainer.meanLoss(net.params, samples);
    const adam = new Adam(net.params.length);
    const losses = trainer.train(net.params, adam, samples, { ...DEFAULT_TRAIN, lr: 3e-3, batch: 32, epochs: 30, seed: 1 });
    const after = trainer.meanLoss(net.params, samples);
    expect(losses).toHaveLength(30);
    expect(after).toBeLessThan(before * 0.5);
    expect(adam.step).toBe(30 * Math.ceil(400 / 32));
  });

  it('is deterministic for a fixed seed', () => {
    const rng = new Rng(4);
    const base = Network.random([132, 8, 4, 1], () => rng.next());
    const list = positions(100, 8);
    const samples = pack(list, list.map((_, i) => (i % 3) - 1));
    const run = (): Float32Array => {
      const params = base.params.slice();
      new NetTrainer(base.sizes).train(params, new Adam(params.length), samples, { ...DEFAULT_TRAIN, lr: 1e-3, seed: 77 });
      return params;
    };
    expect(run()).toEqual(run());
  });

  it('classifies weights and biases for L2', () => {
    const trainer = new NetTrainer([132, 4, 1]);
    expect(trainer.isWeight(0)).toBe(true);
    expect(trainer.isWeight(132 * 4)).toBe(false);
    expect(trainer.isWeight(132 * 4 + 4)).toBe(true);
    expect(trainer.isWeight(132 * 4 + 4 + 4)).toBe(false);
  });
});

function popcount(b: number): number {
  let n = 0;
  for (let x = b >>> 0; x !== 0; x = (x & (x - 1)) >>> 0) n++;
  return n;
}
