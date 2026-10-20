import { Rng } from '../src/engine/index.ts';
import type { Position, Side } from '../src/engine/index.ts';
import { EXTRA_INPUTS, SPARSE_INPUTS, encode } from '../src/ai/features.ts';
import { paramLayout } from '../src/ai/network.ts';
import type { LayerLayout } from '../src/ai/network.ts';
import type { PackedSamples } from './selfplay.ts';

export type Params = Float32Array | Float64Array;

export interface TrainOptions {
  lr: number;
  batch: number;
  epochs: number;
  l2: number;
  clip: number;
  beta1: number;
  beta2: number;
  seed: number;
}

export const DEFAULT_TRAIN: Omit<TrainOptions, 'lr' | 'seed'> = {
  batch: 256,
  epochs: 2,
  l2: 1e-5,
  clip: 1.0,
  beta1: 0.9,
  beta2: 0.999,
};

const ADAM_EPSILON = 1e-8;

export class Adam {
  readonly m: Float64Array;
  readonly v: Float64Array;
  step: number;

  constructor(size: number, m?: Float64Array, v?: Float64Array, step = 0) {
    this.m = m ?? new Float64Array(size);
    this.v = v ?? new Float64Array(size);
    this.step = step;
    if (this.m.length !== size || this.v.length !== size) throw new Error('Adam state size mismatch');
  }

  apply(params: Params, grad: Float64Array, lr: number, beta1: number, beta2: number): void {
    this.step++;
    const c1 = 1 - Math.pow(beta1, this.step);
    const c2 = 1 - Math.pow(beta2, this.step);
    const { m, v } = this;
    for (let i = 0; i < params.length; i++) {
      const g = grad[i];
      m[i] = beta1 * m[i] + (1 - beta1) * g;
      v[i] = beta2 * v[i] + (1 - beta2) * g * g;
      params[i] -= (lr * (m[i] / c1)) / (Math.sqrt(v[i] / c2) + ADAM_EPSILON);
    }
  }
}

export class NetTrainer {
  readonly sizes: readonly number[];
  readonly layout: readonly LayerLayout[];
  private readonly pre: Float64Array[];
  private readonly post: Float64Array[];
  private readonly delta: Float64Array[];
  private readonly active = new Int32Array(32);
  private readonly extras = new Float32Array(EXTRA_INPUTS);
  private readonly scratchPos = { black: 0, white: 0, kings: 0, turn: 0 as Side };

  constructor(sizes: readonly number[]) {
    this.sizes = [...sizes];
    this.layout = paramLayout(sizes);
    this.pre = this.layout.map((l) => new Float64Array(l.outputs));
    this.post = this.layout.map((l) => new Float64Array(l.outputs));
    this.delta = this.layout.map((l) => new Float64Array(l.outputs));
  }

  forward(params: Params, p: Position): number {
    const count = encode(p, this.active, this.extras);
    return this.forwardEncoded(params, count);
  }

  /** Adds d(½(v - target)²)/dθ to grad and returns the sample loss. */
  forwardBackward(params: Params, p: Position, target: number, grad: Float64Array): number {
    const count = encode(p, this.active, this.extras);
    const v = this.forwardEncoded(params, count);
    const err = v - target;
    this.backward(params, count, err * (1 - v * v), grad);
    return 0.5 * err * err;
  }

  private forwardEncoded(params: Params, count: number): number {
    const layers = this.layout;
    const first = layers[0];
    const width = first.outputs;
    const h = this.pre[0];
    for (let j = 0; j < width; j++) h[j] = params[first.biases + j];
    for (let k = 0; k < count; k++) {
      const row = first.weights + this.active[k] * width;
      for (let j = 0; j < width; j++) h[j] += params[row + j];
    }
    for (let e = 0; e < EXTRA_INPUTS; e++) {
      const x = this.extras[e];
      if (x === 0) continue;
      const row = first.weights + (SPARSE_INPUTS + e) * width;
      for (let j = 0; j < width; j++) h[j] += x * params[row + j];
    }
    const last = layers.length - 1;
    if (last === 0) return Math.tanh(h[0]);
    relu(h, this.post[0]);
    for (let l = 1; l <= last; l++) {
      const layer = layers[l];
      const input = this.post[l - 1];
      const z = this.pre[l];
      const n = layer.inputs;
      for (let o = 0; o < layer.outputs; o++) {
        let s = params[layer.biases + o];
        const row = layer.weights + o * n;
        for (let i = 0; i < n; i++) s += params[row + i] * input[i];
        z[o] = s;
      }
      if (l < last) relu(z, this.post[l]);
    }
    return Math.tanh(this.pre[last][0]);
  }

  private backward(params: Params, count: number, outDelta: number, grad: Float64Array): void {
    const layers = this.layout;
    const last = layers.length - 1;
    this.delta[last][0] = outDelta;
    for (let l = last; l >= 1; l--) {
      const layer = layers[l];
      const d = this.delta[l];
      const input = this.post[l - 1];
      const below = this.delta[l - 1];
      const zBelow = this.pre[l - 1];
      const n = layer.inputs;
      below.fill(0);
      for (let o = 0; o < layer.outputs; o++) {
        const dz = d[o];
        if (dz === 0) continue;
        grad[layer.biases + o] += dz;
        const row = layer.weights + o * n;
        for (let i = 0; i < n; i++) {
          grad[row + i] += dz * input[i];
          below[i] += dz * params[row + i];
        }
      }
      for (let i = 0; i < n; i++) if (zBelow[i] <= 0) below[i] = 0;
    }
    const first = layers[0];
    const width = first.outputs;
    const d0 = this.delta[0];
    for (let j = 0; j < width; j++) grad[first.biases + j] += d0[j];
    for (let k = 0; k < count; k++) {
      const row = first.weights + this.active[k] * width;
      for (let j = 0; j < width; j++) grad[row + j] += d0[j];
    }
    for (let e = 0; e < EXTRA_INPUTS; e++) {
      const x = this.extras[e];
      if (x === 0) continue;
      const row = first.weights + (SPARSE_INPUTS + e) * width;
      for (let j = 0; j < width; j++) grad[row + j] += x * d0[j];
    }
  }

  samplePosition(samples: PackedSamples, i: number): Position {
    const p = this.scratchPos;
    p.black = samples.boards[4 * i];
    p.white = samples.boards[4 * i + 1];
    p.kings = samples.boards[4 * i + 2];
    p.turn = samples.boards[4 * i + 3] as Side;
    return p;
  }

  meanLoss(params: Params, samples: PackedSamples): number {
    const n = samples.targets.length;
    if (n === 0) return 0;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const err = this.forward(params, this.samplePosition(samples, i)) - samples.targets[i];
      total += 0.5 * err * err;
    }
    return total / n;
  }

  isWeight(index: number): boolean {
    for (const layer of this.layout) {
      if (index >= layer.weights && index < layer.biases) return true;
    }
    return false;
  }

  /** Runs minibatch Adam over the samples; returns the mean loss seen per epoch. */
  train(params: Params, adam: Adam, samples: PackedSamples, opts: TrainOptions): number[] {
    const n = samples.targets.length;
    if (n === 0) return [];
    const grad = new Float64Array(params.length);
    const weightMask = new Uint8Array(params.length);
    for (let i = 0; i < params.length; i++) weightMask[i] = this.isWeight(i) ? 1 : 0;
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const rng = new Rng(opts.seed);
    const epochLosses: number[] = [];
    for (let epoch = 0; epoch < opts.epochs; epoch++) {
      shuffle(order, rng);
      let total = 0;
      for (let start = 0; start < n; start += opts.batch) {
        const end = Math.min(n, start + opts.batch);
        grad.fill(0);
        for (let k = start; k < end; k++) {
          const i = order[k];
          total += this.forwardBackward(params, this.samplePosition(samples, i), samples.targets[i], grad);
        }
        finishGradient(grad, params, weightMask, end - start, opts);
        adam.apply(params, grad, opts.lr, opts.beta1, opts.beta2);
      }
      epochLosses.push(total / n);
    }
    return epochLosses;
  }
}

function relu(src: Float64Array, dst: Float64Array): void {
  for (let i = 0; i < src.length; i++) dst[i] = src[i] > 0 ? src[i] : 0;
}

function finishGradient(grad: Float64Array, params: Params, weightMask: Uint8Array, count: number, opts: TrainOptions): void {
  let norm2 = 0;
  for (let i = 0; i < grad.length; i++) {
    let g = grad[i] / count;
    if (weightMask[i] === 1) g += opts.l2 * params[i];
    grad[i] = g;
    norm2 += g * g;
  }
  const norm = Math.sqrt(norm2);
  if (opts.clip > 0 && norm > opts.clip) {
    const scale = opts.clip / norm;
    for (let i = 0; i < grad.length; i++) grad[i] *= scale;
  }
}

function shuffle(order: Uint32Array, rng: Rng): void {
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
}

export function learningRate(gen: number, base: number): number {
  if (gen < 100) return base;
  if (gen < 200) return base / 2;
  return base / 4;
}

export function lambdaFor(gen: number, override: number | null): number {
  if (override !== null) return override;
  return gen < 10 ? 0.9 : 0.7;
}
