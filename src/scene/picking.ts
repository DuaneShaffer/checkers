import { PerspectiveCamera, Ray, Vector2, Vector3 } from 'three';
import type { Sq } from '../engine/types.ts';
import { squareAtWorld, squareCenter } from './dims.ts';
import { projectToCanvas, type Rect } from './cameraRig.ts';

export type SurfaceHeight = (sq: Sq) => number;

const ndc = new Vector2();
const origin = new Vector3();
const hit = new Vector3();
const near = new Vector3();

export function rayFromClient(camera: PerspectiveCamera, canvas: Rect, clientX: number, clientY: number, out = new Ray()): Ray {
  ndc.set(((clientX - canvas.left) / canvas.width) * 2 - 1, -((clientY - canvas.top) / canvas.height) * 2 + 1);
  origin.setFromMatrixPosition(camera.matrixWorld);
  out.origin.copy(origin);
  out.direction.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(origin).normalize();
  return out;
}

export function intersectHorizontal(ray: Ray, y: number, out = hit): Vector3 | null {
  const dy = ray.direction.y;
  if (Math.abs(dy) < 1e-9) return null;
  const t = (y - ray.origin.y) / dy;
  if (t <= 0) return null;
  return out.copy(ray.direction).multiplyScalar(t).add(ray.origin);
}

/**
 * Picks top-down: a ray that passes through the top face of a standing piece selects that
 * piece's square before falling through to the board plane.
 */
export function pickSquare(ray: Ray, surface: SurfaceHeight, levels: readonly number[]): Sq | null {
  for (const y of levels) {
    const p = intersectHorizontal(ray, y);
    if (!p) continue;
    const sq = squareAtWorld(p.x, p.z);
    if (sq !== null && surface(sq) >= y - 1e-6) return sq;
  }
  const p = intersectHorizontal(ray, 0);
  return p ? squareAtWorld(p.x, p.z) : null;
}

export function squareAtClient(
  camera: PerspectiveCamera,
  canvas: Rect,
  clientX: number,
  clientY: number,
  surface: SurfaceHeight,
  levels: readonly number[],
): Sq | null {
  return pickSquare(rayFromClient(camera, canvas, clientX, clientY), surface, levels);
}

export function clientOfSquare(camera: PerspectiveCamera, canvas: Rect, sq: Sq, surface: SurfaceHeight): { x: number; y: number } {
  const c = squareCenter(sq);
  const p = projectToCanvas(camera, { x: c.x, y: surface(sq), z: c.z }, canvas.width, canvas.height);
  return { x: canvas.left + p.x, y: canvas.top + p.y };
}

export function nearestSquare(ray: Ray, candidates: Iterable<Sq>, surface: SurfaceHeight, radius: number): Sq | null {
  let best: Sq | null = null;
  let bestDist = radius;
  for (const sq of candidates) {
    const p = intersectHorizontal(ray, surface(sq), near);
    if (!p) continue;
    const c = squareCenter(sq);
    const d = Math.hypot(p.x - c.x, p.z - c.z);
    if (d <= bestDist) {
      bestDist = d;
      best = sq;
    }
  }
  return best;
}
