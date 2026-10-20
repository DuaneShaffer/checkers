import { Group, Mesh, type Material } from 'three';
import { has } from '../engine/bitboard.ts';
import type { Position, Side, Sq } from '../engine/types.ts';
import {
  KING_HEIGHT,
  PIECE_HEIGHT,
  TRAY_PIECE_SCALE,
  squareCenter,
  traySlot,
  type TrayLayout,
  type Vec3Like,
} from './dims.ts';
import { PIECE_TOP_INSET, type PieceModel } from './pieceModel.ts';
import type { PieceIds } from './types.ts';

export interface PieceEntity {
  id: number;
  side: Side;
  king: boolean;
  sq: Sq | null;
  group: Group;
  body: Mesh;
  top: Mesh;
  crown: Mesh;
  lift: number;
  pending: boolean;
}

export interface Pose extends Vec3Like {
  scale: number;
}

const PIECES_PER_SIDE = 12;
const CROWN_Y = PIECE_HEIGHT - PIECE_TOP_INSET + 0.0075;

export function sequentialIds(pos: Position): PieceIds {
  const ids = new Int16Array(32).fill(-1);
  let next = 0;
  for (let sq = 0; sq < 32; sq++) if (has((pos.black | pos.white) >>> 0, sq)) ids[sq] = next++;
  return ids;
}

interface Target {
  sq: Sq;
  side: Side;
  king: boolean;
  id: number;
}

function targetsOf(pos: Position, ids: PieceIds): Target[] {
  const out: Target[] = [];
  for (let sq = 0; sq < 32; sq++) {
    const side: Side | null = has(pos.black, sq) ? 0 : has(pos.white, sq) ? 1 : null;
    if (side === null) continue;
    out.push({ sq, side, king: has(pos.kings, sq), id: ids[sq] ?? -1 });
  }
  return out;
}

function distance(a: Sq, b: Sq): number {
  const pa = squareCenter(a);
  const pb = squareCenter(b);
  return Math.hypot(pa.x - pb.x, pa.z - pb.z);
}

export interface SyncChange {
  entity: PieceEntity;
  from: Pose;
  wasOnBoard: boolean;
  wasKing: boolean;
  fresh: boolean;
}

export class Pieces {
  readonly root = new Group();
  readonly entities: PieceEntity[] = [];
  private model: PieceModel;
  private layout: TrayLayout = 'ends';
  private trays: Record<Side, PieceEntity[]> = { 0: [], 1: [] };
  private crownYaw = Math.PI;

  constructor(model: PieceModel) {
    this.model = model;
    this.root.name = 'pieces';
  }

  setModel(model: PieceModel): void {
    this.model = model;
    for (const e of this.entities) {
      e.body.geometry = model.body;
      e.top.geometry = model.body;
      e.crown.geometry = model.crown;
      e.crown.material = model.materials.crown;
      this.applyMaterial(e);
    }
  }

  setTrayLayout(layout: TrayLayout): void {
    this.layout = layout;
  }

  /** Crowns face up the screen for whoever is viewing. */
  setViewerSide(side: Side): void {
    this.crownYaw = side === 0 ? Math.PI : 0;
    for (const e of this.entities) e.crown.rotation.y = this.crownYaw;
  }

  entityAt(sq: Sq): PieceEntity | undefined {
    return this.entities.find((e) => e.sq === sq);
  }

  surfaceAt(sq: Sq): number {
    const e = this.entityAt(sq);
    if (!e) return 0;
    return e.king ? KING_HEIGHT : PIECE_HEIGHT;
  }

  restPose(e: PieceEntity): Pose {
    if (e.sq !== null) {
      const c = squareCenter(e.sq);
      return { x: c.x, y: 0, z: c.z, scale: 1 };
    }
    const owner = (1 - e.side) as Side;
    const slot = Math.max(0, this.trays[owner].indexOf(e));
    return { ...traySlot(owner, slot, this.layout), scale: TRAY_PIECE_SCALE };
  }

  currentPose(e: PieceEntity): Pose {
    return { x: e.group.position.x, y: e.group.position.y - e.lift, z: e.group.position.z, scale: e.group.scale.x };
  }

  setPose(e: PieceEntity, p: Pose): void {
    e.group.position.set(p.x, p.y + e.lift, p.z);
    e.group.scale.setScalar(p.scale);
  }

  snap(e: PieceEntity): void {
    this.setPose(e, this.restPose(e));
    e.top.visible = e.king;
    e.top.position.y = PIECE_HEIGHT;
    e.top.scale.setScalar(1);
  }

  snapAll(): void {
    for (const e of this.entities) this.snap(e);
  }

  /** Temporarily shows every mesh and material variant so their shaders can be compiled up front. */
  async withAllVariantsShown(fn: () => Promise<unknown>): Promise<void> {
    const sample = this.entities[0];
    const tops = this.entities.map((e) => e.top.visible);
    for (const e of this.entities) e.top.visible = true;
    if (sample) sample.body.material = this.model.materials.pending[sample.side];
    try {
      await fn();
    } finally {
      this.entities.forEach((e, i) => (e.top.visible = tops[i]));
      if (sample) this.applyMaterial(sample);
    }
  }

  setPending(e: PieceEntity, pending: boolean): void {
    if (e.pending === pending) return;
    e.pending = pending;
    this.applyMaterial(e);
  }

  /** Model-only: moves the piece and sends captures to the mover's tray. Visuals are left to the animator. */
  applyMove(from: Sq, to: Sq, captured: readonly Sq[], promotes: boolean): { mover: PieceEntity | undefined; taken: PieceEntity[] } {
    const mover = this.entityAt(from);
    const taken = captured.map((sq) => this.entityAt(sq)).filter((e): e is PieceEntity => e !== undefined);
    for (const e of taken) this.toTray(e);
    if (mover) {
      mover.sq = to;
      if (promotes) mover.king = true;
    }
    return { mover, taken };
  }

  /**
   * Model-only reconciliation with a new position. Entities keep their meshes; returns what changed
   * so the caller can animate from each entity's previous pose.
   */
  reconcile(pos: Position, ids: PieceIds): SyncChange[] {
    const before = new Map(this.entities.map((e) => [e, { pose: this.currentPose(e), onBoard: e.sq !== null, king: e.king, sq: e.sq }]));
    const targets = targetsOf(pos, ids);
    const free = new Set(this.entities);
    const assign = new Map<Target, PieceEntity>();
    const take = (t: Target, e: PieceEntity | undefined) => {
      if (!e) return;
      assign.set(t, e);
      free.delete(e);
    };
    const unassigned = () => targets.filter((t) => !assign.has(t));

    for (const t of targets) {
      if (t.id < 0) continue;
      take(t, [...free].find((e) => e.id === t.id && e.side === t.side));
    }
    for (const t of unassigned()) take(t, [...free].find((e) => e.side === t.side && e.sq === t.sq));
    for (const t of unassigned()) {
      const candidates = [...free].filter((e) => e.side === t.side && e.sq !== null);
      candidates.sort((a, b) => distance(a.sq as Sq, t.sq) - distance(b.sq as Sq, t.sq));
      take(t, candidates[0]);
    }
    for (const t of unassigned()) {
      const tray = this.trays[(1 - t.side) as Side];
      take(t, [...tray].reverse().find((e) => free.has(e)));
    }
    for (const t of unassigned()) take(t, this.create(t.side));

    for (const e of free) if (e.sq !== null) this.toTray(e);
    for (const [t, e] of assign) {
      this.removeFromTray(e);
      e.sq = t.sq;
      e.king = t.king;
      if (t.id >= 0) e.id = t.id;
    }
    this.fillTrays();

    const changes: SyncChange[] = [];
    for (const e of this.entities) {
      const prev = before.get(e);
      if (!prev) {
        changes.push({ entity: e, from: this.restPose(e), wasOnBoard: false, wasKing: e.king, fresh: true });
        continue;
      }
      const rest = this.restPose(e);
      const moved = Math.abs(rest.x - prev.pose.x) > 1e-4 || Math.abs(rest.z - prev.pose.z) > 1e-4 || Math.abs(rest.y - prev.pose.y) > 1e-4;
      if (moved || prev.king !== e.king || prev.onBoard !== (e.sq !== null)) {
        changes.push({ entity: e, from: prev.pose, wasOnBoard: prev.onBoard, wasKing: prev.king, fresh: false });
      }
    }
    return changes;
  }

  /** Keeps 12 of each colour visible: anything not on the board sits in the capturer's tray. */
  private fillTrays(): void {
    for (const side of [0, 1] as Side[]) {
      const count = this.entities.filter((e) => e.side === side).length;
      for (let i = count; i < PIECES_PER_SIDE; i++) {
        const e = this.create(side);
        this.toTray(e);
        this.snap(e);
      }
    }
  }

  private toTray(e: PieceEntity): void {
    if (e.sq === null && this.trays[(1 - e.side) as Side].includes(e)) return;
    e.sq = null;
    e.king = false;
    this.trays[(1 - e.side) as Side].push(e);
  }

  private removeFromTray(e: PieceEntity): void {
    for (const side of [0, 1] as Side[]) {
      const i = this.trays[side].indexOf(e);
      if (i >= 0) this.trays[side].splice(i, 1);
    }
  }

  private nextId(): number {
    return this.entities.reduce((m, e) => Math.max(m, e.id), 999) + 1;
  }

  private create(side: Side): PieceEntity {
    const body = new Mesh(this.model.body, this.model.materials.body[side]);
    const top = new Mesh(this.model.body, this.model.materials.body[side]);
    const crown = new Mesh(this.model.crown, this.model.materials.crown);
    for (const m of [body, top, crown]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    crown.position.y = CROWN_Y;
    crown.rotation.y = this.crownYaw;
    top.add(crown);
    top.position.y = PIECE_HEIGHT;
    top.visible = false;
    const group = new Group();
    group.add(body, top);
    this.root.add(group);
    const e: PieceEntity = { id: this.nextId(), side, king: false, sq: null, group, body, top, crown, lift: 0, pending: false };
    this.entities.push(e);
    return e;
  }

  private applyMaterial(e: PieceEntity): void {
    const mat: Material = e.pending ? this.model.materials.pending[e.side] : this.model.materials.body[e.side];
    e.body.material = mat;
    e.top.material = mat;
  }
}
