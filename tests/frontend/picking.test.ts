import { describe, expect, it } from 'vitest';
import type { Side, Sq } from '../../src/engine/types.ts';
import { applySlotProjection, homeFraming, newCamera, placeCamera, projectToCanvas, type Rect } from '../../src/scene/cameraRig.ts';
import { KING_HEIGHT, PIECE_HEIGHT, squareAtWorld, squareCenter } from '../../src/scene/dims.ts';
import { clientOfSquare, nearestSquare, rayFromClient, squareAtClient, type SurfaceHeight } from '../../src/scene/picking.ts';

const LEVELS = [KING_HEIGHT, PIECE_HEIGHT];

function setup(side: Side, canvas: Rect, slot: Rect) {
  const camera = newCamera();
  const framing = homeFraming(slot.width, slot.height, side);
  placeCamera(camera, framing.pose);
  applySlotProjection(camera, canvas.width, canvas.height, slot, framing.center);
  return camera;
}

const LAYOUTS: { name: string; canvas: Rect; slot: Rect }[] = [
  { name: 'phone portrait, canvas offset in page', canvas: { left: 0, top: 30, width: 390, height: 844 }, slot: { left: 8, top: 120, width: 374, height: 560 } },
  { name: 'desktop', canvas: { left: 0, top: 0, width: 1440, height: 900 }, slot: { left: 24, top: 24, width: 1020, height: 852 } },
  { name: 'landscape phone', canvas: { left: 0, top: 0, width: 844, height: 390 }, slot: { left: 150, top: 8, width: 520, height: 374 } },
];

const empty: SurfaceHeight = () => 0;
const initial: SurfaceHeight = (sq) => (sq < 12 || sq >= 20 ? PIECE_HEIGHT : 0);
const kingsEverywhere: SurfaceHeight = () => KING_HEIGHT;

describe('picking', () => {
  for (const l of LAYOUTS) {
    for (const side of [0, 1] as Side[]) {
      const camera = setup(side, l.canvas, l.slot);
      for (const [label, surface] of [
        ['empty board', empty],
        ['initial position', initial],
        ['all kings', kingsEverywhere],
      ] as [string, SurfaceHeight][]) {
        it(`${l.name}, side ${side}, ${label}: clientOfSquare round-trips through squareAtClient`, () => {
          for (let sq: Sq = 0; sq < 32; sq++) {
            const p = clientOfSquare(camera, l.canvas, sq, surface);
            expect(squareAtClient(camera, l.canvas, p.x, p.y, surface, LEVELS)).toBe(sq);
          }
        });
      }
    }
  }

  it('returns null for light squares and points off the board', () => {
    const l = LAYOUTS[1];
    const camera = setup(0, l.canvas, l.slot);
    expect(squareAtClient(camera, l.canvas, 2, 2, empty, LEVELS)).toBeNull();
    for (const [row, col] of [[0, 0], [3, 3], [7, 7], [4, 2]]) {
      const light = projectToCanvas(camera, { x: col - 3.5, y: 0, z: row - 3.5 }, l.canvas.width, l.canvas.height);
      expect(squareAtClient(camera, l.canvas, light.x, light.y, initial, LEVELS)).toBeNull();
    }
    const a = clientOfSquare(camera, l.canvas, 0, empty);
    const b = clientOfSquare(camera, l.canvas, 4, empty);
    const between = { x: (a.x + b.x) / 2, y: a.y };
    const ray = rayFromClient(camera, l.canvas, between.x, between.y);
    const t = -ray.origin.y / ray.direction.y;
    const sq = squareAtWorld(ray.origin.x + ray.direction.x * t, ray.origin.z + ray.direction.z * t);
    expect(squareAtClient(camera, l.canvas, between.x, between.y, empty, LEVELS)).toBe(sq);
  });

  it('selects a standing piece by its top face, not the square behind it', () => {
    const l = LAYOUTS[1];
    const camera = setup(0, l.canvas, l.slot);
    const onlyNine: SurfaceHeight = (sq) => (sq === 9 ? KING_HEIGHT : 0);
    const c = squareCenter(9);
    const farEdge = projectToCanvas(camera, { x: c.x, y: KING_HEIGHT, z: c.z + 0.38 }, l.canvas.width, l.canvas.height);
    const x = l.canvas.left + farEdge.x;
    const y = l.canvas.top + farEdge.y;
    expect(squareAtClient(camera, l.canvas, x, y, onlyNine, LEVELS)).toBe(9);
    expect(squareAtClient(camera, l.canvas, x, y, empty, LEVELS)).not.toBe(9);
  });

  it('maps every playable square center to itself in world space', () => {
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const sq = squareAtWorld(col - 3.5, row - 3.5);
        expect(sq === null).toBe((row + col) % 2 === 0);
      }
    }
  });

  it('snaps a near miss to the closest candidate square, at the candidate surface height', () => {
    const l = LAYOUTS[0];
    const camera = setup(0, l.canvas, l.slot);
    const target: Sq = 13;
    const piece: Sq = 9;
    const surface: SurfaceHeight = (sq) => (sq === piece ? PIECE_HEIGHT : 0);
    const client = (x: number, y: number, z: number) => {
      const p = projectToCanvas(camera, { x, y, z }, l.canvas.width, l.canvas.height);
      return rayFromClient(camera, l.canvas, l.canvas.left + p.x, l.canvas.top + p.y);
    };
    const t = squareCenter(target);
    expect(nearestSquare(client(t.x + 0.55, 0, t.z), [target, piece], surface, 0.6)).toBe(target);
    expect(nearestSquare(client(t.x + 0.7, 0, t.z), [target, piece], surface, 0.6)).toBeNull();
    const pc = squareCenter(piece);
    expect(nearestSquare(client(pc.x, PIECE_HEIGHT, pc.z - 0.52), [target, piece], surface, 0.6)).toBe(piece);
    expect(nearestSquare(client(t.x, 0, t.z + 0.5), [], surface, 0.6)).toBeNull();
  });

  it('a near-miss radius of 0.6 never reaches past a light square into another dark square', () => {
    for (let sq: Sq = 0; sq < 32; sq++) {
      const c = squareCenter(sq);
      for (let k = 0; k < 64; k++) {
        const a = (k / 64) * Math.PI * 2;
        const hitSq = squareAtWorld(c.x + Math.cos(a) * 0.6, c.z + Math.sin(a) * 0.6);
        expect(hitSq === null || hitSq === sq).toBe(true);
      }
    }
  });
});
