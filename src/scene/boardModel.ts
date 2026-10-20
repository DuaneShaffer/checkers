import {
  BufferAttribute,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Path,
  PlaneGeometry,
  Shape,
  Vector3,
  type BufferGeometry,
  type Material,
  type Texture,
} from 'three';
import {
  FIELD_HALF,
  FRAME_BOTTOM,
  FRAME_HALF,
  FRAME_TOP,
  TRAY_CENTER,
  TRAY_FLOOR,
  TRAY_LENGTH,
  TRAY_TOP,
  TRAY_WIDTH,
  type TrayLayout,
} from './dims.ts';
import { RAIL_TEX_ACROSS, RAIL_TEX_LENGTH, makeFieldTextures, makeRailTextures } from './textures.ts';

const BEVEL = 0.035;
const SEAM_OVERLAP = 0.01;

type UvMapper = (p: Vector3, n: Vector3, centroid: Vector3) => [number, number];

/** Rewrites UVs per triangle (non-indexed geometry) so grain follows the part, not the extrusion. */
function remapUvs(geo: BufferGeometry, mapper: UvMapper): void {
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const n = new Vector3();
  const p = new Vector3();
  const centroid = new Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    centroid.copy(a).add(b).add(c).divideScalar(3);
    n.subVectors(c, b).cross(p.subVectors(a, b)).normalize();
    for (let k = 0; k < 3; k++) {
      p.fromBufferAttribute(pos, i + k);
      const [u, v] = mapper(p, n, centroid);
      uv[(i + k) * 2] = u;
      uv[(i + k) * 2 + 1] = v;
    }
  }
  geo.setAttribute('uv', new BufferAttribute(uv, 2));
}

function sideV(y: number): number {
  return 0.52 + ((y - FRAME_BOTTOM) / (FRAME_TOP - FRAME_BOTTOM)) * 0.44;
}

const FRAME_CORNER_RADIUS = 0.18;
const Y_AXIS = new Vector3(0, 1, 0);

/** Quarter turns about +y that bring the rail containing `c` onto the near (z < 0) rail. */
function railQuarterTurns(c: Vector3): number {
  if (Math.abs(c.z) >= Math.abs(c.x)) return c.z < 0 ? 0 : 2;
  return c.x < 0 ? 1 : 3;
}

/**
 * One extrusion (outer outline with the field as a hole) bevelled once, so the mitred corners have
 * no per-rail bevel grooves. Each quadrant gets its own rail's grain direction.
 */
function frameGeometry(): BufferGeometry {
  const hi = FIELD_HALF + BEVEL - SEAM_OVERLAP;
  const ho = FRAME_HALF - BEVEL;
  const shape = new Shape();
  roundedRect(shape, ho, ho, FRAME_CORNER_RADIUS - BEVEL);
  const hole = new Path();
  hole.moveTo(-hi, -hi);
  hole.lineTo(hi, -hi);
  hole.lineTo(hi, hi);
  hole.lineTo(-hi, hi);
  hole.closePath();
  shape.holes.push(hole);
  const geo = new ExtrudeGeometry(shape, {
    depth: FRAME_TOP - FRAME_BOTTOM - 2 * BEVEL,
    bevelEnabled: true,
    bevelThickness: BEVEL,
    bevelSize: BEVEL,
    bevelSegments: 3,
    curveSegments: 5,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, FRAME_BOTTOM + BEVEL, 0);
  geo.clearGroups();
  const local = new Vector3();
  remapUvs(geo, (p, n, centroid) => {
    const turns = railQuarterTurns(centroid);
    local.copy(p).applyAxisAngle(Y_AXIS, (-turns * Math.PI) / 2);
    const along = (local.x + RAIL_TEX_LENGTH / 2) / RAIL_TEX_LENGTH;
    const u = turns % 2 === 1 ? 1 - along : along;
    if (n.y > 0.3) {
      const across = Math.max(0, -local.z - FIELD_HALF);
      return [u, Math.min(0.5, (across / RAIL_TEX_ACROSS) * 0.5)];
    }
    return [u, sideV(local.y)];
  });
  return geo;
}

function roundedRect(path: Path | Shape, hw: number, hd: number, r: number): void {
  path.moveTo(-hw + r, -hd);
  path.lineTo(hw - r, -hd);
  path.quadraticCurveTo(hw, -hd, hw, -hd + r);
  path.lineTo(hw, hd - r);
  path.quadraticCurveTo(hw, hd, hw - r, hd);
  path.lineTo(-hw + r, hd);
  path.quadraticCurveTo(-hw, hd, -hw, hd - r);
  path.lineTo(-hw, -hd + r);
  path.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
}

const TRAY_BEVEL = 0.02;
const TRAY_WALL = 0.075;

/** A tray running along x, centered at the origin. */
function trayWallGeometry(): BufferGeometry {
  const hw = TRAY_LENGTH / 2 - TRAY_BEVEL;
  const hd = TRAY_WIDTH / 2 - TRAY_BEVEL;
  const outer = new Shape();
  roundedRect(outer, hw, hd, 0.16);
  const hole = new Path();
  roundedRect(hole, hw - TRAY_WALL, hd - TRAY_WALL, 0.1);
  outer.holes.push(hole);
  const depth = TRAY_TOP - FRAME_BOTTOM - 2 * TRAY_BEVEL;
  const geo = new ExtrudeGeometry(outer, {
    depth,
    bevelEnabled: true,
    bevelThickness: TRAY_BEVEL,
    bevelSize: TRAY_BEVEL,
    bevelSegments: 2,
    curveSegments: 6,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, FRAME_BOTTOM + TRAY_BEVEL, 0);
  geo.clearGroups();
  remapUvs(geo, (p, n) => {
    const u = (p.x + RAIL_TEX_LENGTH / 2) / RAIL_TEX_LENGTH;
    if (n.y > 0.3) return [u, 0.6 + (p.z / TRAY_WIDTH) * 0.2];
    if (Math.abs(n.x) > 0.7) return [0.5 + p.z / RAIL_TEX_LENGTH, sideV(p.y)];
    return [u, sideV(p.y)];
  });
  return geo;
}

export interface BoardModel {
  group: Group;
  setTrayLayout(layout: TrayLayout): void;
  setMaterialTier(physical: boolean): void;
  dispose(): void;
}

interface WoodMaps {
  map: Texture;
  orm: Texture;
}

interface WoodPart {
  meshes: Mesh[];
  maps: WoodMaps;
  metal: boolean;
  material: Material;
}

function woodPart(meshes: Mesh[], maps: WoodMaps, metal: boolean, physical: boolean): WoodPart {
  const material = lacquerWood(maps, physical, metal);
  for (const m of meshes) m.material = material;
  return { meshes, maps, metal, material };
}

function lacquerWood(maps: WoodMaps, physical: boolean, metal: boolean): Material {
  const base = {
    map: maps.map,
    roughnessMap: maps.orm,
    metalnessMap: metal ? maps.orm : null,
    metalness: metal ? 1 : 0,
    roughness: 1,
  };
  if (!physical) return new MeshStandardMaterial(base);
  return new MeshPhysicalMaterial({ ...base, clearcoat: 0.5, clearcoatRoughness: 0.16 });
}

export function createBoardModel(opts: {
  fieldSize: number;
  anisotropy: number;
  physical: boolean;
  shadowTexture: Texture;
}): BoardModel {
  const group = new Group();
  group.name = 'board';

  const field = makeFieldTextures(opts.fieldSize, opts.anisotropy);
  const rail = makeRailTextures(1024, opts.anisotropy);

  const fieldGeo = new PlaneGeometry(FIELD_HALF * 2, FIELD_HALF * 2);
  fieldGeo.rotateX(-Math.PI / 2);
  const fieldMesh = new Mesh(fieldGeo);
  fieldMesh.receiveShadow = true;
  fieldMesh.name = 'field';

  const frameGeo = frameGeometry();
  const frameMesh = new Mesh(frameGeo);
  frameMesh.castShadow = true;
  frameMesh.receiveShadow = true;
  frameMesh.name = 'frame';

  const trayGeo = trayWallGeometry();
  const feltGeo = new PlaneGeometry(TRAY_LENGTH - 0.1, TRAY_WIDTH - 0.1);
  feltGeo.rotateX(-Math.PI / 2);
  const feltMat = new MeshStandardMaterial({ color: '#163126', roughness: 0.95, metalness: 0 });
  const trayWalls: Mesh[] = [];
  const trays: Group[] = [0, 1].map((side) => {
    const g = new Group();
    g.name = `tray-${side}`;
    const walls = new Mesh(trayGeo);
    trayWalls.push(walls);
    walls.castShadow = true;
    walls.receiveShadow = true;
    const felt = new Mesh(feltGeo, feltMat);
    felt.position.y = TRAY_FLOOR;
    felt.receiveShadow = true;
    g.add(walls, felt);
    return g;
  });

  const shadowGeo = new PlaneGeometry(1, 1);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadowMat = new MeshBasicMaterial({
    map: opts.shadowTexture,
    color: 0x000000,
    transparent: true,
    depthWrite: false,
    opacity: 0.85,
  });
  const contact = new Mesh(shadowGeo, shadowMat);
  contact.position.y = FRAME_BOTTOM - 0.01;
  contact.renderOrder = -1;

  group.add(contact, fieldMesh, frameMesh, ...trays);

  const setTrayLayout = (layout: TrayLayout) => {
    trays.forEach((t, side) => {
      const sign = side === 0 ? -1 : 1;
      if (layout === 'ends') {
        t.position.set(0, 0, sign * TRAY_CENTER);
        t.rotation.y = 0;
      } else {
        t.position.set(sign * TRAY_CENTER, 0, 0);
        t.rotation.y = Math.PI / 2;
      }
    });
    const long = (TRAY_CENTER + TRAY_WIDTH) * 2 + 2.2;
    const short = FRAME_HALF * 2 + 2.6;
    if (layout === 'ends') contact.scale.set(short, 1, long);
    else contact.scale.set(long, 1, short);
  };
  setTrayLayout('ends');

  let physical = opts.physical;
  const woodParts: WoodPart[] = [
    woodPart([fieldMesh], field, false, physical),
    woodPart([frameMesh], rail, true, physical),
    woodPart(trayWalls, rail, false, physical),
  ];

  return {
    group,
    setTrayLayout,
    setMaterialTier(next) {
      if (next === physical) return;
      physical = next;
      for (const part of woodParts) {
        part.material.dispose();
        part.material = lacquerWood(part.maps, physical, part.metal);
        for (const m of part.meshes) m.material = part.material;
      }
    },
    dispose() {
      for (const g of [fieldGeo, frameGeo, trayGeo, feltGeo, shadowGeo]) g.dispose();
      for (const m of [...woodParts.map((p) => p.material), feltMat, shadowMat]) m.dispose();
      for (const t of [field.map, field.orm, rail.map, rail.orm]) t.dispose();
    },
  };
}
