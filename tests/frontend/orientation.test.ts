import { describe, expect, it } from 'vitest';
import { rowColToSq, sqToRowCol } from '../../src/engine/bitboard.ts';
import type { Side, Sq } from '../../src/engine/types.ts';
import { applySlotProjection, homeFraming, newCamera, placeCamera, projectToCanvas } from '../../src/scene/cameraRig.ts';
import { isDarkCell, squareCenter, traySlot } from '../../src/scene/dims.ts';

const VIEWPORTS = [
  { name: 'portrait phone', w: 390, h: 600 },
  { name: 'square', w: 700, h: 700 },
  { name: 'landscape', w: 1040, h: 820 },
  { name: 'wide landscape', w: 620, h: 360 },
];

function viewer(side: Side, w: number, h: number) {
  const camera = newCamera();
  const framing = homeFraming(w, h, side);
  placeCamera(camera, framing.pose);
  applySlotProjection(camera, w, h, { left: 0, top: 0, width: w, height: h }, framing.center);
  const cell = (row: number, col: number) => projectToCanvas(camera, { x: col - 3.5, y: 0, z: row - 3.5 }, w, h);
  const square = (sq: Sq) => {
    const c = squareCenter(sq);
    return projectToCanvas(camera, { x: c.x, y: 0, z: c.z }, w, h);
  };
  return { cell, square };
}

/** Corners of the 8x8 grid as the given player sees them on screen. */
function screenCorners(side: Side, w: number, h: number) {
  const { cell } = viewer(side, w, h);
  const corners = [
    [0, 0],
    [0, 7],
    [7, 0],
    [7, 7],
  ].map(([row, col]) => ({ row, col, ...cell(row, col) }));
  const byY = [...corners].sort((a, b) => b.y - a.y);
  const near = byY.slice(0, 2).sort((a, b) => a.x - b.x);
  const far = byY.slice(2).sort((a, b) => a.x - b.x);
  return { nearLeft: near[0], nearRight: near[1], farLeft: far[0], farRight: far[1] };
}

describe('board orientation', () => {
  for (const vp of VIEWPORTS) {
    for (const side of [0, 1] as Side[]) {
      describe(`side ${side} view, ${vp.name}`, () => {
        it("puts a dark square in each player's near-left corner", () => {
          const c = screenCorners(side, vp.w, vp.h);
          expect(isDarkCell(c.nearLeft.row, c.nearLeft.col)).toBe(true);
          expect(isDarkCell(c.farRight.row, c.farRight.col)).toBe(true);
          expect(isDarkCell(c.nearRight.row, c.nearRight.col)).toBe(false);
          expect(isDarkCell(c.farLeft.row, c.farLeft.col)).toBe(false);
        });

        it('puts the single corner at near-left (PDN 4 for side 0, PDN 29 for side 1)', () => {
          const c = screenCorners(side, vp.w, vp.h);
          const sq = rowColToSq(c.nearLeft.row, c.nearLeft.col);
          expect(sq !== null ? sq + 1 : null).toBe(side === 0 ? 4 : 29);
          const far = rowColToSq(c.farRight.row, c.farRight.col);
          expect(far !== null ? far + 1 : null).toBe(side === 0 ? 29 : 4);
        });

        it("puts the double corner on the viewer's right", () => {
          const { square } = viewer(side, vp.w, vp.h);
          const double = side === 0 ? [1, 5] : [32, 28];
          const single = side === 0 ? 4 : 29;
          for (const pdn of double) {
            expect(square(pdn - 1).x).toBeGreaterThan(vp.w / 2);
            expect(square(pdn - 1).x).toBeGreaterThan(square(single - 1).x);
          }
          const [corner, inner] = double.map((pdn) => square(pdn - 1));
          expect(corner.y).toBeGreaterThan(inner.y);
        });

        it("shows the viewer's own men nearest the bottom of the screen", () => {
          const { square } = viewer(side, vp.w, vp.h);
          const own = side === 0 ? [0, 11] : [20, 31];
          const theirs = side === 0 ? [20, 31] : [0, 11];
          for (let sq = own[0]; sq <= own[1]; sq++) expect(square(sq).y).toBeGreaterThan(vp.h / 2);
          for (let sq = theirs[0]; sq <= theirs[1]; sq++) expect(square(sq).y).toBeLessThan(vp.h / 2);
        });

        it('is not mirrored: PDN 1-4 run left to right only from side 1 view', () => {
          const { square } = viewer(side, vp.w, vp.h);
          const row0 = [0, 1, 2, 3].map((sq) => square(sq).x);
          const ascending = row0.every((x, i) => i === 0 || x > row0[i - 1]);
          expect(ascending).toBe(side === 1);
        });

        it("puts the viewer's capture tray in front of them (ends) or on their right (sides)", () => {
          const { square } = viewer(side, vp.w, vp.h);
          const w = vp.w, h = vp.h;
          const camera = newCamera();
          const framing = homeFraming(w, h, side);
          placeCamera(camera, framing.pose);
          applySlotProjection(camera, w, h, { left: 0, top: 0, width: w, height: h }, framing.center);
          const ownEnd = projectToCanvas(camera, traySlot(side, 5, 'ends'), w, h);
          const ownSide = projectToCanvas(camera, traySlot(side, 5, 'sides'), w, h);
          const nearest = Math.max(...Array.from({ length: 32 }, (_, sq) => square(sq).y));
          expect(ownEnd.y).toBeGreaterThan(nearest);
          expect(ownSide.x).toBeGreaterThan(w / 2);
        });
      });
    }
  }

  it('numbers squares per the standard diagram (1 top row, 29 bottom-left from White)', () => {
    expect(sqToRowCol(0)).toEqual({ row: 0, col: 1 });
    expect(sqToRowCol(3)).toEqual({ row: 0, col: 7 });
    expect(sqToRowCol(4)).toEqual({ row: 1, col: 0 });
    expect(sqToRowCol(28)).toEqual({ row: 7, col: 0 });
    expect(sqToRowCol(31)).toEqual({ row: 7, col: 6 });
  });
});
