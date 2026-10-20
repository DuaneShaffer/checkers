import type { Position } from '../engine/types.ts';
import { CKN1_MAGIC, CKN1_VERSION, ckn1HeaderBytes, ckn1ParamCount } from '../shared/formats.ts';
import { EXTRA_INPUTS, INPUTS, SPARSE_INPUTS, encode } from './features.ts';
import type { Evaluator } from './search.ts';
import { EVAL_RANGE } from './protocol.ts';

export interface LayerLayout {
  inputs: number;
  outputs: number;
  weights: number;
  biases: number;
  transposed: boolean;
}

export function paramLayout(sizes: readonly number[]): LayerLayout[] {
  const layers: LayerLayout[] = [];
  let offset = 0;
  for (let l = 1; l < sizes.length; l++) {
    const inputs = sizes[l - 1];
    const outputs = sizes[l];
    const weights = offset;
    const biases = weights + inputs * outputs;
    layers.push({ inputs, outputs, weights, biases, transposed: l === 1 });
    offset = biases + outputs;
  }
  return layers;
}

export function validateSizes(sizes: readonly number[]): void {
  if (sizes.length < 2) throw new Error(`Network needs at least 2 layers, got ${sizes.length}`);
  if (sizes[0] !== INPUTS) throw new Error(`Network input size must be ${INPUTS}, got ${sizes[0]}`);
  if (sizes[sizes.length - 1] !== 1) throw new Error(`Network output size must be 1, got ${sizes[sizes.length - 1]}`);
  for (const n of sizes) {
    if (!Number.isInteger(n) || n < 1 || n > 4096) throw new Error(`Bad layer size ${n}`);
  }
}

const active = new Int32Array(32);
const extras = new Float32Array(EXTRA_INPUTS);

export class Network {
  readonly sizes: readonly number[];
  readonly params: Float32Array;
  gen: number;
  readonly layout: readonly LayerLayout[];
  private readonly acts: Float64Array[];

  constructor(sizes: readonly number[], params?: Float32Array, gen = 0) {
    validateSizes(sizes);
    const count = ckn1ParamCount(sizes);
    if (params && params.length !== count) throw new Error(`Expected ${count} params, got ${params.length}`);
    this.sizes = [...sizes];
    this.params = params ?? new Float32Array(count);
    this.gen = gen;
    this.layout = paramLayout(sizes);
    this.acts = this.sizes.slice(1).map((n) => new Float64Array(n));
  }

  static random(sizes: readonly number[], rng: () => number, gen = 0): Network {
    const net = new Network(sizes, undefined, gen);
    const last = net.layout.length - 1;
    net.layout.forEach((layer, l) => {
      const limit = l === last ? 0.01 : Math.sqrt(6 / layer.inputs);
      const end = layer.weights + layer.inputs * layer.outputs;
      for (let i = layer.weights; i < end; i++) net.params[i] = (rng() * 2 - 1) * limit;
    });
    return net;
  }

  static fromBinary(data: ArrayBuffer | ArrayBufferView): Network {
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 16) throw new Error('CKN1: file too short');
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== CKN1_MAGIC) throw new Error(`CKN1: bad magic "${magic}"`);
    const version = view.getUint32(4, true);
    if (version !== CKN1_VERSION) throw new Error(`CKN1: unsupported version ${version}`);
    const gen = view.getUint32(8, true);
    const nLayers = view.getUint32(12, true);
    if (nLayers < 2 || nLayers > 16) throw new Error(`CKN1: bad layer count ${nLayers}`);
    const header = ckn1HeaderBytes(nLayers);
    if (bytes.byteLength < header) throw new Error('CKN1: truncated header');
    const sizes: number[] = [];
    for (let i = 0; i < nLayers; i++) sizes.push(view.getUint32(16 + 4 * i, true));
    validateSizes(sizes);
    const count = ckn1ParamCount(sizes);
    const expected = header + 4 * count;
    if (bytes.byteLength !== expected) throw new Error(`CKN1: expected ${expected} bytes, got ${bytes.byteLength}`);
    const params = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const v = view.getFloat32(header + 4 * i, true);
      if (!Number.isFinite(v)) throw new Error(`CKN1: non-finite parameter at ${i}`);
      params[i] = v;
    }
    return new Network(sizes, params, gen);
  }

  toBinary(): ArrayBuffer {
    const n = this.sizes.length;
    const header = ckn1HeaderBytes(n);
    const buf = new ArrayBuffer(header + 4 * this.params.length);
    const view = new DataView(buf);
    for (let i = 0; i < 4; i++) view.setUint8(i, CKN1_MAGIC.charCodeAt(i));
    view.setUint32(4, CKN1_VERSION, true);
    view.setUint32(8, this.gen >>> 0, true);
    view.setUint32(12, n, true);
    this.sizes.forEach((size, i) => view.setUint32(16 + 4 * i, size, true));
    for (let i = 0; i < this.params.length; i++) view.setFloat32(header + 4 * i, this.params[i], true);
    return buf;
  }

  clone(): Network {
    return new Network(this.sizes, this.params.slice(), this.gen);
  }

  value(p: Position): number {
    const count = encode(p, active, extras);
    return this.valueFromFeatures(active, count, extras);
  }

  valueFromFeatures(activeInputs: Int32Array, count: number, extraInputs: Float32Array): number {
    const w = this.params;
    const first = this.layout[0];
    const h = this.acts[0];
    const width = first.outputs;
    for (let j = 0; j < width; j++) h[j] = w[first.biases + j];
    for (let k = 0; k < count; k++) {
      const row = first.weights + activeInputs[k] * width;
      for (let j = 0; j < width; j++) h[j] += w[row + j];
    }
    for (let e = 0; e < EXTRA_INPUTS; e++) {
      const x = extraInputs[e];
      if (x === 0) continue;
      const row = first.weights + (SPARSE_INPUTS + e) * width;
      for (let j = 0; j < width; j++) h[j] += x * w[row + j];
    }
    const last = this.layout.length - 1;
    if (last === 0) return Math.tanh(h[0]);
    for (let j = 0; j < width; j++) if (h[j] < 0) h[j] = 0;

    let input = h;
    for (let l = 1; l <= last; l++) {
      const layer = this.layout[l];
      const out = this.acts[l];
      const n = layer.inputs;
      for (let o = 0; o < layer.outputs; o++) {
        let s = w[layer.biases + o];
        const row = layer.weights + o * n;
        for (let i = 0; i < n; i++) s += w[row + i] * input[i];
        out[o] = l === last || s > 0 ? s : 0;
      }
      input = out;
    }
    return Math.tanh(input[0]);
  }
}

export class NetEvaluator implements Evaluator {
  readonly net: Network;

  constructor(net: Network) {
    this.net = net;
  }

  evaluate(p: Position): number {
    return Math.round(this.net.value(p) * EVAL_RANGE);
  }
}
