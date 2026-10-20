import { PerspectiveCamera, Vector3 } from 'three';
import type { Side } from '../engine/types.ts';
import { framingPoints, type TrayLayout, type Vec3Like } from './dims.ts';

export const CAMERA_FOV = 25;
export const FIT_PADDING = 0.035;
const DEG = Math.PI / 180;

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

/**
 * Finds the camera distance at which `points` exactly fill a slot of the given aspect
 * (with padding), once the projected bounding box is re-centered on the slot.
 */
export function fitToSlot(
  aspect: number,
  polar: number,
  azimuth: number,
  points: readonly Vec3Like[],
  padding = FIT_PADDING,
): Omit<Framing, 'layout'> {
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
  return { pose, center: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } };
}

/** Frames the board for `side`, putting the capture trays wherever they cost the board the least size. */
export function homeFraming(slotW: number, slotH: number, side: Side): Framing {
  const aspect = slotW / slotH;
  const polar = polarForAspect(aspect);
  const fits = (['ends', 'sides'] as const).map((layout) => ({
    ...fitToSlot(aspect, polar, homeAzimuth(side), framingPoints(layout)),
    layout,
  }));
  return fits[0].pose.distance <= fits[1].pose.distance ? fits[0] : fits[1];
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
