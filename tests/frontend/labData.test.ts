import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  LabDataError,
  createLabData,
  defaultGeneration,
  generationsWithNets,
  nextGeneration,
  opponentLabel,
  parseGenFile,
  parseManifest,
  playerName,
  previousGeneration,
} from '../../src/lab/data.ts';
import { niceTicks, eloLayout, placeBaselineLabel, type LabelBox } from '../../src/lab/eloChart.ts';
import { emptyManifest } from '../../src/shared/formats.ts';

const FIXTURES = join(import.meta.dirname, '../fixtures/training');
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(FIXTURES, rel), 'utf8'));

function fixtureFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (url: string) => {
    const rel = url.replace(/^.*\/training\//, '');
    if (rel in overrides) {
      const body = overrides[rel];
      if (body instanceof Response) return body;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    try {
      return new Response(readFileSync(join(FIXTURES, rel)), { status: 200 });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

describe('parseManifest', () => {
  it('accepts the fixture manifest', () => {
    const m = parseManifest(readJson('manifest.json'));
    expect(m.generations).toHaveLength(40);
    expect(m.champion).toBe(37);
    expect(m.baselines.map((b) => b.id)).toEqual(['random', 'heur2', 'heur4', 'heur6']);
    expect(generationsWithNets(m).map((g) => g.gen)).toEqual([0, 10, 37, 39]);
  });

  it('accepts the empty placeholder manifest', () => {
    const m = parseManifest(emptyManifest());
    expect(m.generations).toEqual([]);
    expect(defaultGeneration(m)).toBeNull();
  });

  it('rejects non-manifests', () => {
    for (const bad of [null, 42, {}, { format: 2, rules: 'english-draughts', generations: [], baselines: [] }, { format: 1, rules: 'english-draughts', generations: {} }]) {
      expect(() => parseManifest(bad)).toThrowError(LabDataError);
    }
  });

  it('drops malformed generations, sorts, dedupes and repairs fields', () => {
    const raw = {
      ...emptyManifest(),
      champion: 99,
      baselines: [{ id: 'heur4', name: 'Heuristic d4', elo: 1000 }, { id: 'bogus', name: 'x', elo: 1 }, { id: 'random', name: 'Random', elo: 'NaN' }],
      generations: [
        { gen: 2, elo: 1100, eloErr: 30, games: 6000, vs: { heur4: { w: 5, d: 3, l: 2 }, prev: { w: -1, d: 0, l: 0 }, junk: { w: 1, d: 1, l: 1 } }, replay: 'gens/gen-0002.json', net: '' },
        { gen: 0, elo: 600 },
        { gen: 1, elo: 'high' },
        { gen: -1, elo: 3 },
        null,
        { gen: 2, elo: 1200, eloErr: 20 },
      ],
    };
    const m = parseManifest(raw);
    expect(m.generations.map((g) => g.gen)).toEqual([0, 2]);
    expect(m.generations[1].elo).toBe(1200);
    expect(m.champion).toBeNull();
    expect(m.baselines.map((b) => b.id)).toEqual(['heur4']);
    expect(m.generations[0]).toMatchObject({ eloErr: 0, games: 0, replay: null, net: null, vs: {} });
    const first = parseManifest({ ...raw, generations: [raw.generations[0]] }).generations[0];
    expect(Object.keys(first.vs)).toEqual(['heur4']);
    expect(first.net).toBeNull();
  });
});

describe('parseGenFile', () => {
  it('accepts every fixture gen file', () => {
    const m = parseManifest(readJson('manifest.json'));
    for (const g of m.generations) {
      const file = parseGenFile(readJson(g.replay!), g.gen);
      expect(file.games.length).toBe(6);
      expect(file.games.filter((r) => r.kind === 'selfplay')).toHaveLength(4);
      expect(file.games.every((r) => r.evals?.length === r.moves.length)).toBe(true);
    }
  });

  it('rejects a file for the wrong generation', () => {
    expect(() => parseGenFile(readJson('gens/gen-0003.json'), 4)).toThrowError(/Expected generation 4/);
  });

  it('rejects structurally invalid files', () => {
    expect(() => parseGenFile(null, 1)).toThrowError(LabDataError);
    expect(() => parseGenFile({ format: 2, gen: 1, games: [] }, 1)).toThrowError(LabDataError);
    expect(() => parseGenFile({ format: 1, gen: 1.5, games: [] }, 1)).toThrowError(LabDataError);
    expect(() => parseGenFile({ format: 1, gen: 1, games: {} }, 1)).toThrowError(LabDataError);
  });

  it('keeps valid records when others are null or malformed', () => {
    const ok = { id: 'a', kind: 'selfplay', black: 1, white: 1, moves: ['11-15'], result: '1/2-1/2', reason: 'agreement' };
    const file = parseGenFile({ format: 1, gen: 3, games: [null, 7, { id: 3, moves: [] }, { id: 'x' }, ok] }, 3);
    expect(file.games.map((g) => g.id)).toEqual(['a']);
  });

  it('filters out malformed records and duplicate ids', () => {
    const ok = { id: 'a', kind: 'selfplay', black: 1, white: 1, moves: ['11-15'], result: '1/2-1/2', reason: 'agreement', evals: [0, 'x'] };
    const file = parseGenFile({
      format: 1,
      gen: 1,
      games: [
        ok,
        { ...ok },
        { ...ok, id: 'b', kind: 'blitz' },
        { ...ok, id: 'c', result: '2-0' },
        { ...ok, id: 'd', black: 'alien' },
        { ...ok, id: 'e', moves: ['11-15', 7] },
        { ...ok, id: 'f', reason: 'timeout' },
        { ...ok, id: 'g', black: 'heur4', white: 0, evals: [12] },
      ],
    }, 1);
    expect(file.games.map((g) => g.id)).toEqual(['a', 'g']);
    expect(file.games[0].evals).toBeUndefined();
    expect(file.games[1].evals).toEqual([12]);
  });
});

describe('createLabData', () => {
  it('loads the manifest under BASE_URL/training/ and caches it', async () => {
    const fetchFn = fixtureFetch();
    const data = createLabData({ base: '/checkers/', fetch: fetchFn });
    const [a, b] = await Promise.all([data.manifest(), data.manifest()]);
    expect(a).toBe(b);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe('/checkers/training/manifest.json');
    expect(data.url('nets/gen-0010.bin')).toBe('/checkers/training/nets/gen-0010.bin');
    await data.manifest({ refresh: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('loads gen files lazily and caches them', async () => {
    const fetchFn = fixtureFetch();
    const data = createLabData({ base: '/checkers', fetch: fetchFn });
    await data.manifest();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [f1, f2] = await Promise.all([data.genFile(5), data.genFile(5)]);
    expect(f1).toBe(f2);
    expect(f1.gen).toBe(5);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1][0]).toBe('/checkers/training/gens/gen-0005.json');
    const rec = await data.game(5, 'g5-s2');
    expect(rec.id).toBe('g5-s2');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('reports missing generations and games', async () => {
    const data = createLabData({ base: '/', fetch: fixtureFetch() });
    await expect(data.genFile(400)).rejects.toMatchObject({ kind: 'missing' });
    await expect(data.game(3, 'nope')).rejects.toMatchObject({ kind: 'missing' });
  });

  it('classifies network, 404 and invalid-JSON failures and retries after them', async () => {
    let calls = 0;
    const flaky = vi.fn(async (url: string) => {
      calls++;
      if (calls === 1) throw new TypeError('Failed to fetch');
      return fixtureFetch()(url);
    });
    const data = createLabData({ base: '/', fetch: flaky });
    await expect(data.manifest()).rejects.toMatchObject({ kind: 'network' });
    await expect(data.manifest()).resolves.toMatchObject({ format: 1 });

    const missing = createLabData({ base: '/', fetch: fixtureFetch({ 'manifest.json': new Response('', { status: 404 }) }) });
    await expect(missing.manifest()).rejects.toMatchObject({ kind: 'missing' });

    const garbled = createLabData({ base: '/', fetch: fixtureFetch({ 'manifest.json': new Response('{nope', { status: 200 }) }) });
    await expect(garbled.manifest()).rejects.toMatchObject({ kind: 'invalid' });

    const wrongGen = createLabData({ base: '/', fetch: fixtureFetch({ 'gens/gen-0002.json': readJson('gens/gen-0001.json') }) });
    await expect(wrongGen.genFile(2)).rejects.toMatchObject({ kind: 'invalid' });
  });
});

describe('manifest helpers', () => {
  const m = parseManifest(readJson('manifest.json'));

  it('navigates generations', () => {
    expect(previousGeneration(m, 0)).toBeUndefined();
    expect(previousGeneration(m, 5)?.gen).toBe(4);
    expect(nextGeneration(m, 39)).toBeUndefined();
    expect(nextGeneration(m, 5)?.gen).toBe(6);
    expect(defaultGeneration(m)).toBe(37);
  });

  it('names players and opponents', () => {
    expect(playerName(m, 12)).toBe('Gen 12');
    expect(playerName(m, 'heur4')).toBe('Heuristic d4');
    expect(playerName(null, 'random')).toBe('Random mover');
    expect(opponentLabel(m, 'prev', 12)).toBe('Gen 11');
    expect(opponentLabel(m, 'prev10', 12)).toBe('Gen 2');
  });
});

describe('elo chart geometry', () => {
  it('makes round ticks', () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(380, 1420, 5)).toEqual([400, 600, 800, 1000, 1200, 1400]);
    expect(niceTicks(5, 5)).toEqual([5]);
  });

  it('places every generation inside the plot and snaps to the nearest one', () => {
    const m = parseManifest(readJson('manifest.json'));
    const L = eloLayout(m, 600, 300);
    for (const g of m.generations) {
      const x = L.x(g.gen), y = L.y(g.elo);
      expect(x).toBeGreaterThanOrEqual(L.plot.left);
      expect(x).toBeLessThanOrEqual(L.plot.right);
      expect(y).toBeGreaterThanOrEqual(L.plot.top);
      expect(y).toBeLessThanOrEqual(L.plot.bottom);
      expect(L.genAtX(x + 1)?.gen).toBe(g.gen);
    }
    for (const b of m.baselines) expect(L.y(b.elo)).toBeLessThanOrEqual(L.plot.bottom);
  });

  it('keeps baseline labels clear of the curve and of each other at phone widths', () => {
    const m = parseManifest(readJson('manifest.json'));
    for (const width of [240, 288, 320, 380, 600, 900]) {
      const L = eloLayout(m, width, 240);
      const taken: LabelBox[] = [];
      for (const b of m.baselines) {
        const y = L.y(b.elo);
        const spot = placeBaselineLabel(m, L, y, [`${b.name} · ${Math.round(b.elo)}`, `${b.id} · ${Math.round(b.elo)}`], taken);
        const box = spot.box;
        for (const g of m.generations) {
          const px = L.x(g.gen), py = L.y(g.elo);
          const hit = px + 3.5 > box.left && px - 3.5 < box.right && py + 3.5 > box.top && py - 3.5 < box.bottom;
          expect(hit, `${width}px: "${spot.text}" covers gen ${g.gen}`).toBe(false);
        }
        for (const t of taken) {
          const hit = t.right > box.left && t.left < box.right && t.bottom > box.top && t.top < box.bottom;
          expect(hit, `${width}px: "${spot.text}" overlaps another label`).toBe(false);
        }
        expect(box.bottom).toBeLessThanOrEqual(L.plot.bottom);
        taken.push(box);
      }
    }
  });

  it('handles a single generation', () => {
    const m = parseManifest({ ...emptyManifest(), generations: [{ gen: 0, elo: 500, eloErr: 50 }] });
    const L = eloLayout(m, 400, 200);
    expect(Number.isFinite(L.x(0))).toBe(true);
    expect(L.genAtX(0)?.gen).toBe(0);
  });
});
