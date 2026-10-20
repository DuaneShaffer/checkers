import { PerspectiveCamera, Vector3 } from 'three';
import type { Side } from '../engine/types.ts';
import { framingPoints, type TrayLayout, type Vec3Like } from './dims.ts';

export const CAMERA_FOV = 25;
export const FIT_PADDING = 0.035;
const DEG = Math.PI / 180;
export const MIN_POLAR = 12 * DEG;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Pose {
  polar: number;
  azimuth: number;
  distance: number;
}

export interface Framing {
  pose: Pose;
  layout: TrayLayout;
  /** NDC (slot-relative) of the framed bounding-box center, shifted onto the slot center. */
  center: { x: number; y: number };
}

interface Fit extends Omit<Framing, 'layout'> {
  fill: { x: number; y: number };
}

/** Orbit azimuth (three.js Spherical theta) that puts `side`'s home rows nearest the camera. */
export function homeAzimuth(side: Side): number {
  return side === 0 ? Math.PI : 0;
}

export function polarForAspect(aspect: number): number {
  const t = smoothstep(0.62, 1.45, aspect);
  return (27 + t * 13) * DEG;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function cameraPosition(pose: Pose, out = new Vector3()): Vector3 {
  const s = Math.sin(pose.polar) * pose.distance;
  return out.set(s * Math.sin(pose.azimuth), Math.cos(pose.polar) * pose.distance, s * Math.cos(pose.azimuth));
}

export function placeCamera(camera: PerspectiveCamera, pose: Pose): void {
  cameraPosition(pose, camera.position);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
}

export function newCamera(): PerspectiveCamera {
  return new PerspectiveCamera(CAMERA_FOV, 1, 1, 200);
}

interface NdcBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const tmp = new Vector3();

function ndcBounds(camera: PerspectiveCamera, points: readonly Vec3Like[]): NdcBounds {
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const p of points) {
    tmp.set(p.x, p.y, p.z).project(camera);
    b.minX = Math.min(b.minX, tmp.x);
    b.maxX = Math.max(b.maxX, tmp.x);
    b.minY = Math.min(b.minY, tmp.y);
    b.maxY = Math.max(b.maxY, tmp.y);
  }
  return b;
}

function requiredScale(b: NdcBounds, padding: number): number {
  return Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2 / (1 - padding);
}

/** Distance is fitted after re-centering the projected bounding box on the slot. */
export function fitToSlot(
  aspect: number,
  polar: number,
  azimuth: number,
  points: readonly Vec3Like[],
  padding = FIT_PADDING,
): Fit {
  const camera = new PerspectiveCamera(CAMERA_FOV, aspect, 0.1, 1000);
  let lo = 2;
  let hi = 400;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    placeCamera(camera, { polar, azimuth, distance: mid });
    if (requiredScale(ndcBounds(camera, points), padding) > 1) lo = mid;
    else hi = mid;
  }
  const pose = { polar, azimuth, distance: hi };
  placeCamera(camera, pose);
  const b = ndcBounds(camera, points);
  return {
    pose,
    center: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 },
    fill: { x: (b.maxX - b.minX) / 2, y: (b.maxY - b.minY) / 2 },
  };
}

function bestLayout(aspect: number, polar: number, azimuth: number): Fit & { layout: TrayLayout } {
  const fits = (['ends', 'sides'] as const).map((layout) => ({
    ...fitToSlot(aspect, polar, azimuth, framingPoints(layout)),
    layout,
  }));
  return fits[0].pose.distance <= fits[1].pose.distance ? fits[0] : fits[1];
}

const hasVerticalSlack = (f: Fit) => f.fill.y < f.fill.x - 1e-3;

export function homeFraming(slotW: number, slotH: number, side: Side): Framing {
  const aspect = slotW / slotH;
  const azimuth = homeAzimuth(side);
  const natural = polarForAspect(aspect);
  let best = bestLayout(aspect, natural, azimuth);
  if (hasVerticalSlack(best) && natural > MIN_POLAR) {
    const flattest = bestLayout(aspect, MIN_POLAR, azimuth);
    if (hasVerticalSlack(flattest)) best = flattest;
    else {
      let lo = MIN_POLAR;
      let hi = natural;
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2;
        const f = bestLayout(aspect, mid, azimuth);
        if (hasVerticalSlack(f)) {
          hi = mid;
          best = f;
        } else lo = mid;
      }
    }
  }
  return { pose: best.pose, center: best.center, layout: best.layout };
}

/**
 * Projects the camera so its natural frame is the slot (aspect, centering) while rendering the
 * whole host canvas. `slot` is relative to the canvas' top-left corner, in CSS pixels.
 */
export function applySlotProjection(
  camera: PerspectiveCamera,
  canvasW: number,
  canvasH: number,
  slot: Rect,
  center: { x: number; y: number },
): void {
  const offX = -slot.left + (center.x * slot.width) / 2;
  const offY = -slot.top - (center.y * slot.height) / 2;
  camera.setViewOffset(slot.width, slot.height, offX, offY, canvasW, canvasH);
}

export function projectToCanvas(camera: PerspectiveCamera, p: Vec3Like, canvasW: number, canvasH: number): { x: number; y: number } {
  tmp.set(p.x, p.y, p.z).project(camera);
  return { x: ((tmp.x + 1) / 2) * canvasW, y: ((1 - tmp.y) / 2) * canvasH };
}
