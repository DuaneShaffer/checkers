import {
  AdditiveBlending,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  PlaneGeometry,
  type Blending,
  type Texture,
} from 'three';
import type { Sq } from '../engine/types.ts';
import { squareCenter } from './dims.ts';
import type { HighlightTextures } from './textures.ts';
import type { Highlights } from './types.ts';

interface Kind {
  material: MeshBasicMaterial;
  size: number;
  y: number;
  pool: Mesh[];
}

function material(map: Texture, color: string, opacity: number, blending: Blending = NormalBlending): MeshBasicMaterial {
  return new MeshBasicMaterial({
    map,
    color: new Color(color),
    transparent: true,
    opacity,
    depthWrite: false,
    blending,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

export type HighlightKind = 'lastMove' | 'movable' | 'selected' | 'target' | 'capture' | 'cursor';

export class HighlightLayer {
  readonly root = new Group();
  private readonly geometry: PlaneGeometry;
  private readonly kinds: Record<HighlightKind, Kind>;

  constructor(tex: HighlightTextures) {
    this.root.name = 'highlights';
    this.geometry = new PlaneGeometry(1, 1);
    this.geometry.rotateX(-Math.PI / 2);
    const kind = (m: MeshBasicMaterial, size: number, y: number): Kind => ({ material: m, size, y, pool: [] });
    this.kinds = {
      lastMove: kind(material(tex.square, '#f0b85c', 0.26), 0.98, 0.002),
      movable: kind(material(tex.glowRing, '#f2c062', 0.95, AdditiveBlending), 1.12, 0.003),
      selected: kind(material(tex.glowRing, '#fff0c4', 1, AdditiveBlending), 1.2, 0.0035),
      target: kind(material(tex.dot, '#f3cf86', 1), 0.48, 0.004),
      capture: kind(material(tex.ring, '#ff5b3d', 0.95), 0.98, 0.0045),
      cursor: kind(material(tex.outline, '#ffffff', 0.92), 1.0, 0.005),
    };
  }

  set(h: Highlights): void {
    const selected = h.selected ?? null;
    this.place('lastMove', h.lastMove ? [h.lastMove[0], h.lastMove[1]] : []);
    this.place('movable', (h.movable ?? []).filter((sq) => sq !== selected));
    this.place('selected', selected === null ? [] : [selected]);
    this.place('target', h.targets ?? []);
    this.place('capture', h.captureTargets ?? []);
    this.place('cursor', h.cursor === null || h.cursor === undefined ? [] : [h.cursor]);
  }

  private place(name: HighlightKind, squares: readonly Sq[]): void {
    const k = this.kinds[name];
    while (k.pool.length < squares.length) {
      const m = new Mesh(this.geometry, k.material);
      m.scale.setScalar(k.size);
      m.renderOrder = 1;
      m.name = `hl-${name}`;
      this.root.add(m);
      k.pool.push(m);
    }
    k.pool.forEach((m, i) => {
      const sq = squares[i];
      m.visible = sq !== undefined;
      if (sq === undefined) return;
      const c = squareCenter(sq);
      m.position.set(c.x, k.y, c.z);
    });
  }

  dispose(): void {
    this.geometry.dispose();
    for (const k of Object.values(this.kinds)) k.material.dispose();
  }
}
