import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Game, has, squares, toFen } from '../../src/engine/index.ts';
import type { GenFile } from '../../src/shared/formats.ts';
import {
  ReplayError,
  advanceIds,
  buildTimeline,
  clampPly,
  evalToWinProbability,
  fullMoveLabel,
  initialIds,
} from '../../src/lab/replayTimeline.ts';

const FIXTURES = join(import.meta.dirname, '../fixtures/training');
const genFiles: GenFile[] = readdirSync(join(FIXTURES, 'gens'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(FIXTURES, 'gens', f), 'utf8')));
const allGames = genFiles.flatMap((f) => f.games);

function occupiedIds(ids: Int16Array): number[] {
  return [...ids].filter((id) => id >= 0);
}

describe('buildTimeline', () => {
  it('has fixture games to replay', () => {
    expect(genFiles.length).toBeGreaterThanOrEqual(40);
    expect(allGames.length).toBeGreaterThanOrEqual(200);
  });

  it('matches Game replay at every ply for every fixture game', () => {
    for (const rec of allGames) {
      const t = buildTimeline(rec);
      const game = new Game({ startFen: rec.startFen });
      expect(t.length).toBe(rec.moves.length);
      expect(t.positions).toHaveLength(rec.moves.length + 1);
      expect(toFen(t.positions[0])).toBe(game.fen());
      rec.moves.forEach((mv, i) => {
        game.play(mv);
        expect(toFen(t.positions[i + 1]), `${rec.id} ply ${i + 1}`).toBe(game.fen());
        expect(t.plies[i].notation).toBe(mv);
      });
      const status = game.status();
      if (rec.reason !== 'max-plies') {
        expect(status.over, rec.id).toBe(true);
        if (status.over) expect(status.reason).toBe(rec.reason);
      }
    }
  });

  it('keeps piece ids consistent with the position at every ply', () => {
    for (const rec of allGames) {
      const t = buildTimeline(rec);
      t.ids.forEach((ids, ply) => {
        const pos = t.positions[ply];
        const occ = (pos.black | pos.white) >>> 0;
        for (let sq = 0; sq < 32; sq++) expect(ids[sq] >= 0, `${rec.id} ply ${ply} sq ${sq}`).toBe(has(occ, sq));
        const live = occupiedIds(ids);
        expect(new Set(live).size).toBe(live.length);
      });
    }
  });

  it('moves the same id along each move and retires captured ids', () => {
    for (const rec of allGames.slice(0, 60)) {
      const t = buildTimeline(rec);
      t.plies.forEach(({ move }, i) => {
        const before = t.ids[i];
        const after = t.ids[i + 1];
        expect(after[move.to]).toBe(before[move.from]);
        const retired = [...squares(move.captured)].map((sq) => before[sq]);
        for (const id of retired) expect(occupiedIds(after)).not.toContain(id);
        const survivors = occupiedIds(before).filter((id) => !retired.includes(id));
        expect(occupiedIds(after).sort()).toEqual(survivors.sort());
      });
    }
  });

  it('produces stable snapshot ids across rebuilds', () => {
    const rec = allGames[7];
    const a = buildTimeline(rec);
    const b = buildTimeline(rec);
    expect(a.ids.map((ids) => [...ids])).toEqual(b.ids.map((ids) => [...ids]));
    expect([...a.ids[0]]).toEqual([...initialIds(a.positions[0])]);
  });

  it('keeps a piece id through promotion and flags the crowning ply', () => {
    const crowning = allGames.flatMap((rec) => {
      const t = buildTimeline(rec);
      return t.plies.map((p, i) => ({ t, p, i })).filter(({ p }) => p.crowned);
    });
    expect(crowning.length).toBeGreaterThan(0);
    for (const { t, p, i } of crowning) {
      expect(has(t.positions[i + 1].kings, p.move.to)).toBe(true);
      expect(has(t.positions[i].kings, p.move.from)).toBe(false);
      expect(t.ids[i + 1][p.move.to]).toBe(t.ids[i][p.move.from]);
    }
  });

  it('replays from a custom start FEN', () => {
    const startFen = 'W:W18,K30:B14,23';
    const t = buildTimeline({ startFen, moves: ['18x9'] });
    expect(t.positions[0].turn).toBe(1);
    expect(toFen(t.positions[1])).toBe(Game.fromMoves(['18x9'], { startFen }).fen());
    expect(t.plies[0].captures).toBe(1);
    expect(fullMoveLabel(1, 0)).toEqual({ number: 1, side: 1 });
    expect(fullMoveLabel(1, 1)).toEqual({ number: 2, side: 0 });
  });

  it('reports the ply of an illegal move', () => {
    expect(() => buildTimeline({ moves: ['11-15', '23-19', '15-11'] })).toThrowError(ReplayError);
    try {
      buildTimeline({ moves: ['11-15', '23-19', '15-11'] });
    } catch (e) {
      expect((e as ReplayError).ply).toBe(2);
    }
  });

  it('normalizes evals to one value per position, clamped to ±100', () => {
    const t = buildTimeline({ moves: ['11-15', '23-19'], evals: [5, 250], result: '0-1' });
    expect(t.evals).toEqual([5, 100, -100]);
    const perPosition = buildTimeline({ moves: ['11-15'], evals: [0, -40, 999] });
    expect(perPosition.evals).toEqual([0, -40]);
    expect(buildTimeline({ moves: ['11-15'] }).evals).toEqual([]);
    expect(evalToWinProbability(100)).toBe(1);
    expect(evalToWinProbability(-100)).toBe(0);
    expect(evalToWinProbability(0)).toBe(0.5);
  });

  it('clamps plies into range', () => {
    const t = buildTimeline({ moves: ['11-15', '23-19'] });
    expect(clampPly(t, -3)).toBe(0);
    expect(clampPly(t, 9)).toBe(2);
    expect(clampPly(t, Number.NaN)).toBe(0);
    expect(clampPly(t, 1.7)).toBe(1);
  });

  it('advanceIds does not mutate its input', () => {
    const t = buildTimeline({ moves: ['11-15'] });
    const before = initialIds(t.positions[0]);
    const copy = [...before];
    advanceIds(before, t.plies[0].move);
    expect([...before]).toEqual(copy);
  });
});
