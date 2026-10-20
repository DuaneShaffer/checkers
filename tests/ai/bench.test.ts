import { describe, expect, it } from 'vitest';
import { initialPosition } from '../../src/engine/position.ts';
import { mulberry32 } from '../../src/engine/rng.ts';
import { Network } from '../../src/ai/network.ts';
import { createSearcher, type EvaluatorSource } from '../../src/ai/search.ts';
import { DEFAULT_LAYERS } from '../../src/shared/formats.ts';
import { randomPositions } from './helpers.ts';

function searchRate(source: EvaluatorSource, depth: number, repeats: number): { nps: number; nodes: number; ms: number } {
  const searcher = createSearcher(source, { ttBits: 20 });
  searcher.search(initialPosition(), { maxDepth: Math.min(depth, 6) });
  let nodes = 0;
  const t0 = performance.now();
  for (let i = 0; i < repeats; i++) {
    searcher.clear();
    nodes += searcher.search(initialPosition(), { maxDepth: depth }).nodes;
  }
  const ms = performance.now() - t0;
  return { nps: Math.round((nodes / ms) * 1000), nodes: nodes / repeats, ms: ms / repeats };
}

describe('bench (log only)', () => {
  const net = Network.random(DEFAULT_LAYERS, mulberry32(1));

  it('measures raw network evaluations per second', () => {
    const positions = randomPositions(81, 500);
    for (const p of positions) net.value(p);
    const rounds = 40;
    const t0 = performance.now();
    let sink = 0;
    for (let r = 0; r < rounds; r++) for (const p of positions) sink += net.value(p);
    const ms = performance.now() - t0;
    const perSec = Math.round((rounds * positions.length) / ms * 1000);
    console.log(`[bench] net.value: ${perSec.toLocaleString('en-US')} evals/s (${((ms * 1000) / (rounds * positions.length)).toFixed(2)} µs/eval)`);
    expect(Number.isFinite(sink)).toBe(true);
  });

  it('measures search nodes per second at depth 6 from the opening', () => {
    const heur = searchRate('heuristic', 6, 20);
    const nn = searchRate(net, 6, 20);
    console.log(`[bench] heuristic d6: ${heur.nps.toLocaleString('en-US')} nodes/s (${heur.nodes} nodes, ${heur.ms.toFixed(1)} ms)`);
    console.log(`[bench] net d6:       ${nn.nps.toLocaleString('en-US')} nodes/s (${nn.nodes} nodes, ${nn.ms.toFixed(1)} ms)`);
    const heur9 = searchRate('heuristic', 9, 1);
    const nn9 = searchRate(net, 9, 1);
    console.log(`[bench] heuristic d9: ${heur9.nps.toLocaleString('en-US')} nodes/s (${heur9.nodes} nodes, ${heur9.ms.toFixed(0)} ms)`);
    console.log(`[bench] net d9:       ${nn9.nps.toLocaleString('en-US')} nodes/s (${nn9.nodes} nodes, ${nn9.ms.toFixed(0)} ms)`);
    expect(heur.nodes).toBeGreaterThan(0);
    expect(nn.nodes).toBeGreaterThan(0);
  });
});
