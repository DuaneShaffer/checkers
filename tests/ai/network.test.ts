import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/engine/rng.ts';
import { flip, initialPosition } from '../../src/engine/position.ts';
import type { Position } from '../../src/engine/types.ts';
import { encodeDense } from '../../src/ai/features.ts';
import { NetEvaluator, Network, paramLayout } from '../../src/ai/network.ts';
import { CKN1_MAGIC, DEFAULT_LAYERS, ckn1HeaderBytes, ckn1ParamCount } from '../../src/shared/formats.ts';
import { randomPositions } from './helpers.ts';

function referenceValue(net: Network, p: Position): number {
  let x = Array.from(encodeDense(p));
  const layout = paramLayout(net.sizes);
  layout.forEach((layer, l) => {
    const y: number[] = [];
    for (let o = 0; o < layer.outputs; o++) {
      let s = net.params[layer.biases + o];
      for (let i = 0; i < layer.inputs; i++) {
        const w = layer.transposed ? net.params[layer.weights + i * layer.outputs + o] : net.params[layer.weights + o * layer.inputs + i];
        s += w * x[i];
      }
      y.push(l === layout.length - 1 ? Math.tanh(s) : Math.max(0, s));
    }
    x = y;
  });
  return x[0];
}

function bigNet(seed: number, sizes: readonly number[] = DEFAULT_LAYERS): Network {
  const net = Network.random(sizes, mulberry32(seed), 7);
  const rng = mulberry32(seed + 1);
  const last = paramLayout(sizes).at(-1)!;
  for (let i = last.weights; i < net.params.length; i++) net.params[i] = rng() - 0.5;
  for (let i = 0; i < net.params.length; i += 13) net.params[i] += rng() * 0.1;
  return net;
}

describe('Network', () => {
  it('has 10,625 parameters with the default layers', () => {
    const net = Network.random(DEFAULT_LAYERS, mulberry32(1));
    expect(net.params.length).toBe(10625);
    expect(ckn1ParamCount(DEFAULT_LAYERS)).toBe(10625);
  });

  it('round-trips CKN1 exactly', () => {
    const net = bigNet(3);
    net.gen = 1234;
    const bin = net.toBinary();
    expect(bin.byteLength).toBe(ckn1HeaderBytes(4) + 4 * 10625);
    const bytes = new Uint8Array(bin);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe(CKN1_MAGIC);
    const view = new DataView(bin);
    expect([1, 4, 8, 12, 16, 20, 24, 28].map((o) => (o === 1 ? null : view.getUint32(o, true)))).toEqual([null, 1, 1234, 4, 132, 64, 32, 1]);
    const back = Network.fromBinary(bin);
    expect(back.gen).toBe(1234);
    expect(back.sizes).toEqual([132, 64, 32, 1]);
    expect(new Uint8Array(back.toBinary())).toEqual(bytes);
    expect(Buffer.from(back.params.buffer).equals(Buffer.from(net.params.buffer))).toBe(true);
  });

  it('reads from an unaligned byte view and from custom layer sizes', () => {
    const net = bigNet(4, [132, 16, 8, 4, 1]);
    const bin = new Uint8Array(net.toBinary());
    const padded = new Uint8Array(bin.length + 3);
    padded.set(bin, 3);
    const back = Network.fromBinary(padded.subarray(3));
    expect(back.sizes).toEqual([132, 16, 8, 4, 1]);
    expect(Array.from(back.params)).toEqual(Array.from(net.params));
  });

  it('rejects malformed files', () => {
    const bin = new Uint8Array(bigNet(5).toBinary());
    const corrupt = (fn: (b: Uint8Array) => Uint8Array) => () => Network.fromBinary(fn(bin.slice()));
    expect(corrupt((b) => b.subarray(0, b.length - 4))).toThrow(/expected/);
    expect(corrupt((b) => ((b[0] = 0x58), b))).toThrow(/magic/);
    expect(corrupt((b) => ((b[4] = 2), b))).toThrow(/version/);
    expect(corrupt((b) => ((b[16] = 100), b))).toThrow(/input size/);
    expect(corrupt((b) => b.subarray(0, 10))).toThrow(/short/);
    expect(corrupt((b) => (new DataView(b.buffer).setFloat32(48, NaN, true), b))).toThrow(/non-finite/);
  });

  it('matches a naive dense forward pass', () => {
    const net = bigNet(6);
    for (const p of randomPositions(21, 60)) {
      expect(net.value(p)).toBeCloseTo(referenceValue(net, p), 5);
    }
  });

  it('starts near zero and stays within (-1, 1)', () => {
    const net = Network.random(DEFAULT_LAYERS, mulberry32(9));
    const layout = paramLayout(DEFAULT_LAYERS);
    const biases = layout.flatMap((l) => Array.from(net.params.subarray(l.biases, l.biases + l.outputs)));
    expect(biases.every((b) => b === 0)).toBe(true);
    expect(Math.abs(net.value(initialPosition()))).toBeLessThan(0.05);
    const big = bigNet(10);
    for (const p of randomPositions(22, 40)) {
      const v = big.value(p);
      expect(v).toBeGreaterThan(-1);
      expect(v).toBeLessThan(1);
    }
  });

  it('is deterministic for a given seed', () => {
    const a = Network.random(DEFAULT_LAYERS, mulberry32(42));
    const b = Network.random(DEFAULT_LAYERS, mulberry32(42));
    expect(Array.from(a.params)).toEqual(Array.from(b.params));
  });

  it('values a position and its flipped twin identically', () => {
    const net = bigNet(12);
    for (const p of randomPositions(23, 100)) expect(net.value(flip(p))).toBe(net.value(p));
  });

  it('NetEvaluator returns integers in ±1000', () => {
    const ev = new NetEvaluator(bigNet(13));
    for (const p of randomPositions(24, 50)) {
      const s = ev.evaluate(p);
      expect(Number.isInteger(s)).toBe(true);
      expect(Math.abs(s)).toBeLessThanOrEqual(1000);
      expect(s).toBe(Math.round(ev.net.value(p) * 1000));
    }
  });
});
