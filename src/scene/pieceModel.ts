import {
  Color,
  ExtrudeGeometry,
  LatheGeometry,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Shape,
  SphereGeometry,
  Vector2,
  type BufferGeometry,
  type Material,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Side } from '../engine/types.ts';
import { PIECE_HEIGHT as H, PIECE_RADIUS as R } from './dims.ts';
import { makeReedingNormalMap } from './textures.ts';

const RECESS = 0.012;
export const PIECE_TOP_INSET = RECESS;

function arc(cx: number, cy: number, r: number, from: number, to: number, steps: number): Vector2[] {
  const pts: Vector2[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    pts.push(new Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return pts;
}

interface Profile {
  points: Vector2[];
  wallFrom: number;
  wallTo: number;
}

/** Lathe profile from the bottom center outward and over the top to the center; x = radius, y = height. */
function pieceProfile(): Profile {
  const rb = 0.03;
  const rt = 0.028;
  const pts: Vector2[] = [new Vector2(0, 0), new Vector2(R * 0.55, 0)];
  pts.push(...arc(R - rb, rb, rb, -Math.PI / 2, 0, 5));
  const wallFrom = pts.length - 1;
  pts.push(new Vector2(R, H * 0.5));
  pts.push(new Vector2(R, H - rt));
  const wallTo = pts.length - 1;
  pts.push(...arc(R - rt, H - rt, rt, 0, Math.PI / 2, 5).slice(1));
  const rim = R - rt - 0.02;
  pts.push(new Vector2(rim, H));
  pts.push(new Vector2(rim - 0.012, H - RECESS));
  for (const g of [0.26, 0.16]) {
    pts.push(new Vector2(g + 0.014, H - RECESS));
    pts.push(new Vector2(g, H - RECESS - 0.009));
    pts.push(new Vector2(g - 0.014, H - RECESS));
  }
  pts.push(new Vector2(0, H - RECESS));
  return { points: pts, wallFrom, wallTo };
}

const CROWN_TIPS: [number, number][] = [
  [-0.15, 0.065],
  [-0.075, 0.045],
  [0, 0.1],
  [0.075, 0.045],
  [0.15, 0.065],
];

export function crownShape(): Shape {
  const s = new Shape();
  const base = -0.105;
  const band = -0.045;
  s.moveTo(-0.13, base);
  s.lineTo(0.13, base);
  s.quadraticCurveTo(0.145, base, 0.145, base + 0.015);
  s.lineTo(0.14, band);
  s.lineTo(CROWN_TIPS[4][0], CROWN_TIPS[4][1]);
  for (let i = CROWN_TIPS.length - 1; i > 0; i--) {
    const [x, y] = CROWN_TIPS[i - 1];
    s.quadraticCurveTo((CROWN_TIPS[i][0] + x) / 2, band + 0.005, x, y);
  }
  s.lineTo(-0.14, band);
  s.lineTo(-0.145, base + 0.015);
  s.quadraticCurveTo(-0.145, base, -0.13, base);
  return s;
}

function crownGeometry(): BufferGeometry {
  const depth = 0.014;
  const body = new ExtrudeGeometry(crownShape(), {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.006,
    bevelSize: 0.005,
    bevelSegments: 2,
    curveSegments: 6,
  });
  const parts: BufferGeometry[] = [body];
  for (const [x, y] of CROWN_TIPS) {
    const ball = new SphereGeometry(0.019, 12, 8).toNonIndexed();
    ball.scale(1, 1, 0.75);
    ball.translate(x, y + 0.012, depth / 2);
    parts.push(ball);
  }
  for (const g of parts) g.deleteAttribute('uv');
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  if (!merged) throw new Error('crown merge failed');
  merged.scale(1.12, 1.12, 1);
  merged.rotateX(-Math.PI / 2);
  return merged;
}

export interface PieceMaterials {
  body: Record<Side, Material>;
  pending: Record<Side, Material>;
  crown: Material;
}

export interface PieceModel {
  body: BufferGeometry;
  crown: BufferGeometry;
  materials: PieceMaterials;
  dispose(): void;
}

const CRIMSON = new Color('#a3161f');
const IVORY = new Color('#ece2cb');

function lacquer(color: Color, normalMap: Texture, physical: boolean, pending: boolean): Material {
  const base = {
    color: pending ? color.clone().lerp(new Color('#6e0d0b'), 0.55) : color,
    roughness: 0.4,
    metalness: 0,
    normalMap,
    normalScale: new Vector2(0.9, 0.9),
    emissive: pending ? new Color('#7a0a06') : new Color(0, 0, 0),
    emissiveIntensity: pending ? 0.6 : 0,
  };
  if (!physical) return new MeshStandardMaterial(base);
  return new MeshPhysicalMaterial({
    ...base,
    clearcoat: 0.75,
    clearcoatRoughness: 0.2,
    specularIntensity: 0.6,
  });
}

export function createPieceModel(opts: { segments: number; physical: boolean; anisotropy: number }): PieceModel {
  const profile = pieceProfile();
  const body = new LatheGeometry(profile.points, opts.segments);
  const n = profile.points.length - 1;
  const normalMap = makeReedingNormalMap(56, profile.wallFrom / n, profile.wallTo / n, opts.anisotropy);

  const crown = crownGeometry();

  const gold = { color: '#f6cf73', metalness: 1, roughness: 0.32, envMapIntensity: 3, emissive: '#5c3d0a' };
  const crownMat = opts.physical
    ? new MeshPhysicalMaterial({ ...gold, clearcoat: 0.4, clearcoatRoughness: 0.15 })
    : new MeshStandardMaterial(gold);

  const materials: PieceMaterials = {
    body: { 0: lacquer(CRIMSON, normalMap, opts.physical, false), 1: lacquer(IVORY, normalMap, opts.physical, false) },
    pending: { 0: lacquer(CRIMSON, normalMap, opts.physical, true), 1: lacquer(IVORY, normalMap, opts.physical, true) },
    crown: crownMat,
  };
  (materials.body[1] as MeshStandardMaterial).roughness = 0.36;

  return {
    body,
    crown,
    materials,
    dispose() {
      body.dispose();
      crown.dispose();
      normalMap.dispose();
      for (const m of [materials.body[0], materials.body[1], materials.pending[0], materials.pending[1], crownMat]) m.dispose();
    },
  };
}
