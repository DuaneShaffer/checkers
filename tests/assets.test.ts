import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game, TRAIN_MAX_PLIES, resultString } from '../src/engine/index.ts';
import {
  GEN_FILE_BUDGET_BYTES,
  MAX_SHIPPED_NETS,
  TRAINING_BUDGET_BYTES,
  ckn1HeaderBytes,
  ckn1ParamCount,
  isGenFile,
  isTrainingManifest,
} from '../src/shared/formats.ts';
import type { GenFile, TrainingManifest } from '../src/shared/formats.ts';
import { checkTrainingAssets } from '../trainer/assets-check.ts';

const DIR = resolve(process.env.ASSETS_DIR ?? fileURLToPath(new URL('../public/training/', import.meta.url)));
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as TrainingManifest;

describe(`training assets in ${DIR}`, () => {
  it('has a well-formed manifest', () => {
    expect(isTrainingManifest(manifest)).toBe(true);
    expect(manifest.anchor).toEqual({ id: 'heur4', elo: 1000 });
    expect(manifest.net.layers[0]).toBe(132);
    expect(manifest.net.layers[manifest.net.layers.length - 1]).toBe(1);
    if (manifest.generations.length === 0) expect(manifest.champion).toBeNull();
    else expect(manifest.generations.some((g) => g.gen === manifest.champion && g.net !== null)).toBe(true);
  });

  it('references only files that exist', () => {
    for (const g of manifest.generations) {
      for (const rel of [g.replay, g.net]) if (rel !== null) expect(existsSync(join(DIR, rel)), rel).toBe(true);
    }
  });

  it('ships nets whose size is header + 4 × params', () => {
    const nets = manifest.generations.filter((g) => g.net !== null);
    expect(nets.length).toBeLessThanOrEqual(MAX_SHIPPED_NETS);
    const expected = ckn1HeaderBytes(manifest.net.layers.length) + 4 * ckn1ParamCount(manifest.net.layers);
    for (const g of nets) expect(statSync(join(DIR, g.net!)).size, g.net!).toBe(expected);
  });

  it('replays every game legally with the recorded result', () => {
    for (const g of manifest.generations) {
      if (g.replay === null) continue;
      const path = join(DIR, g.replay);
      expect(statSync(path).size, g.replay).toBeLessThanOrEqual(GEN_FILE_BUDGET_BYTES);
      const file = JSON.parse(readFileSync(path, 'utf8')) as GenFile;
      expect(isGenFile(file), g.replay).toBe(true);
      expect(file.gen).toBe(g.gen);
      for (const rec of file.games) {
        const game = Game.fromMoves(rec.moves, { startFen: rec.startFen, maxPlies: TRAIN_MAX_PLIES });
        const status = game.status();
        expect(status.over, `${g.replay} ${rec.id}`).toBe(true);
        if (status.over) {
          expect(resultString(status.winner), `${g.replay} ${rec.id}`).toBe(rec.result);
          expect(status.reason, `${g.replay} ${rec.id}`).toBe(rec.reason);
        }
        if (rec.evals) expect(rec.evals).toHaveLength(rec.moves.length);
      }
    }
  });

  it('fits the size budget and passes the full asset check', () => {
    const report = checkTrainingAssets(DIR);
    expect(report.totalBytes).toBeLessThanOrEqual(TRAINING_BUDGET_BYTES);
    expect(report.problems).toEqual([]);
  });
});
