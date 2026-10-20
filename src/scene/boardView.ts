import { rowColToSq, sqToRowCol } from '../engine/bitboard.ts';
import { initialPosition } from '../engine/position.ts';
import type { Move, Position, Side, Sq } from '../engine/types.ts';
import { createBoardModel, type BoardModel } from './boardModel.ts';
import { KING_HEIGHT, LIFT_HEIGHT, PIECE_HEIGHT, squareCenter } from './dims.ts';
import { createLighting, type Lighting } from './environment.ts';
import { JUMP_HOP, QUIET_HOP, crownDrop, flyToTray, hop, popIn, squash, type AnimContext, type Motion } from './moveAnimator.ts';
import { HighlightLayer } from './highlights.ts';
import { clientOfSquare as projectSquare, squareAtClient as pickAt } from './picking.ts';
import { createPieceModel, type PieceModel } from './pieceModel.ts';
import { Pieces, sequentialIds, type PieceEntity } from './pieces.ts';
import {
  TIERS,
  initialTier,
  readDeviceHints,
  readStoredTier,
  storeTier,
  type QualityPref,
  type QualityTier,
} from './quality.ts';
import { Stage } from './stage.ts';
import { makeHighlightTextures, type HighlightTextures } from './textures.ts';
import { Run, easeOutCubic, lerp } from './tween.ts';
import type { BoardView, BoardViewOptions, CreateBoardView, Highlights, PieceIds } from './types.ts';

const TAP_SLOP_PX = 9;
const TAP_MAX_MS = 650;
const PICK_LEVELS = [KING_HEIGHT, PIECE_HEIGHT];
const REDUCED_TIME_SCALE = 0.45;
const SYNC_MS = 220;
const LIFT_MS = 150;

export interface BoardViewExtOptions extends BoardViewOptions {
  quality?: QualityPref;
}

export interface BoardViewStats {
  renders: number;
  animating: boolean;
  tier: QualityTier;
}

export interface BoardViewExt extends BoardView {
  setQuality(pref: QualityPref): void;
  stats(): BoardViewStats;
}

interface Preview {
  entity: PieceEntity;
  origin: Sq;
  at: Sq;
  captured: PieceEntity[];
}

interface TrackedPointer {
  x: number;
  y: number;
  t: number;
  tap: boolean;
}

/** Midpoints of each hop, in hop order. */
function jumpedSquares(path: readonly Sq[]): Sq[] {
  const out: Sq[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const a = sqToRowCol(path[i]);
    const b = sqToRowCol(path[i + 1]);
    if (Math.abs(a.row - b.row) !== 2) continue;
    const mid = rowColToSq((a.row + b.row) / 2, (a.col + b.col) / 2);
    if (mid !== null) out.push(mid);
  }
  return out;
}

function squarePose(sq: Sq) {
  const c = squareCenter(sq);
  return { x: c.x, y: 0, z: c.z, scale: 1 };
}

class BoardViewImpl implements BoardViewExt {
  private readonly host: HTMLElement;
  private readonly stage: Stage;
  private readonly lighting: Lighting;
  private readonly board: BoardModel;
  private readonly highlightTextures: HighlightTextures;
  private readonly highlightLayer: HighlightLayer;
  private readonly pieces: Pieces;
  private pieceModel: PieceModel;
  private tier: QualityTier;
  private pref: QualityPref;
  private run = new Run();
  /** Preview hops and their return hop run apart from `run` so cancelling one never strands the other. */
  private previewRun = new Run();
  private returning: PieceEntity | null = null;
  private preview: Preview | null = null;
  private highlights: Highlights = {};
  private readonly tapListeners = new Set<(sq: Sq | null) => void>();
  private readonly pointers = new Map<number, TrackedPointer>();
  private readonly motion: Motion = { arc: 1 };
  private readonly reducedMotion: MediaQueryList;
  private readonly cleanups: (() => void)[] = [];
  private disposed = false;

  constructor(host: HTMLElement, opts: BoardViewExtOptions) {
    this.host = host;
    const testMode = opts.testMode ?? false;
    this.pref = opts.quality ?? 'auto';
    this.tier = testMode ? 'high' : initialTier(this.pref, readDeviceHints(), readStoredTier());
    const spec = TIERS[this.tier];
    const antialias = this.tier === 'high' || window.devicePixelRatio < 2;

    this.stage = new Stage(
      host,
      { antialias, testMode, dprCap: spec.dprCap },
      {
        onLayout: (layout) => {
          this.pieces?.setTrayLayout(layout);
          this.board?.setTrayLayout(layout);
          this.pieces?.snapAll();
        },
        onSlowFrames: () => this.downgrade(),
        onContextRestored: () => this.lighting?.rebuildEnvironment(),
      },
    );
    this.stage.setGovernorEnabled(this.pref === 'auto' && this.tier === 'high');
    const anisotropy = Math.min(8, this.stage.renderer.capabilities.getMaxAnisotropy());

    this.lighting = createLighting(this.stage.renderer, this.stage.scene, spec.shadowMapSize, spec.shadowRadius);
    this.highlightTextures = makeHighlightTextures();
    this.board = createBoardModel({
      fieldSize: spec.fieldTextureSize,
      anisotropy,
      physical: spec.physical,
      shadowTexture: this.highlightTextures.contactShadow,
    });
    this.pieceModel = createPieceModel({ segments: spec.latheSegments, physical: spec.physical, anisotropy });
    this.pieces = new Pieces(this.pieceModel);
    this.highlightLayer = new HighlightLayer(this.highlightTextures);
    this.stage.scene.add(this.board.group, this.highlightLayer.root, this.pieces.root);

    const layout = this.stage.trayLayout;
    this.board.setTrayLayout(layout);
    this.pieces.setTrayLayout(layout);
    this.pieces.setViewerSide(this.stage.viewerSide);

    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const applyMotion = () => {
      const reduced = this.reducedMotion.matches;
      this.motion.arc = reduced ? 0.3 : 1;
      this.stage.tweens.timeScale = reduced ? REDUCED_TIME_SCALE : 1;
    };
    applyMotion();
    this.reducedMotion.addEventListener('change', applyMotion);
    this.cleanups.push(() => this.reducedMotion.removeEventListener('change', applyMotion));

    if (testMode) this.stage.tweens.instant = true;
    this.installPointerHandling();
    this.setPosition(initialPosition());
  }

  /** Compiles every material variant up front (off the main thread where supported), then draws the first frame. */
  async warmUp(): Promise<void> {
    const { renderer, scene, camera } = this.stage;
    const parallel = renderer.extensions.has('KHR_parallel_shader_compile');
    try {
      await this.pieces.withAllVariantsShown(async () => {
        if (parallel) await renderer.compileAsync(scene, camera);
        else renderer.compile(scene, camera);
      });
    } catch {
      /* shaders then compile on the first render instead */
    }
    this.stage.relayout();
  }


  setPosition(pos: Position, ids?: PieceIds): void {
    this.interrupt();
    this.clearPreview();
    this.pieces.reconcile(pos, ids ?? sequentialIds(pos));
    this.pieces.snapAll();
    this.applyPendingTint();
    this.applyLift(false);
    this.stage.markShadowsDirty();
  }

  async sync(pos: Position, ids: PieceIds, opts: { duration?: number } = {}): Promise<void> {
    const run = this.interrupt(false);
    this.clearPreview(false);
    const changes = this.pieces.reconcile(pos, ids);
    this.applyPendingTint();
    const ctx = this.animContext(run, 1);
    const ms = opts.duration ?? SYNC_MS;
    const work: Promise<void>[] = [];
    for (const c of changes) {
      const e = c.entity;
      const rest = this.pieces.restPose(e);
      e.top.position.y = PIECE_HEIGHT;
      if (c.fresh) {
        e.top.visible = e.king;
        if (e.sq !== null) work.push(popIn(ctx, e, ms));
        else this.pieces.snap(e);
        continue;
      }
      const travel = Math.hypot(rest.x - c.from.x, rest.z - c.from.z);
      const longFlight = c.wasOnBoard !== (e.sq !== null) || travel > 2;
      if (!e.king) e.top.visible = false;
      const slide = hop(ctx, e, c.from, rest, longFlight ? 0.7 : 0.12, longFlight ? Math.max(ms, 380) : ms);
      work.push(e.king && !c.wasKing ? slide.then(() => crownDrop(ctx, e)) : slide.then(() => this.pieces.snap(e)));
    }
    this.stage.markShadowsDirty();
    this.stage.invalidate();
    await Promise.all(work);
    if (!run.cancelled) this.applyLift(false);
  }

  async playMove(move: Move, opts: { speed?: number; fromHop?: number } = {}): Promise<void> {
    const preview = this.preview;
    const fromHop = opts.fromHop ?? 0;
    const continuing =
      preview !== null && fromHop > 0 && preview.origin === move.from && preview.at === move.path[fromHop];
    const run = this.interrupt(!continuing);
    if (!continuing) this.clearPreview();
    this.preview = null;

    const captured = jumpedSquares(move.path);
    const mover = this.pieces.entityAt(move.from);
    const wasKing = mover?.king ?? false;
    const { taken } = this.pieces.applyMove(move.from, move.to, captured, move.promotes);
    if (!mover) {
      this.pieces.snapAll();
      this.stage.markShadowsDirty();
      return;
    }
    const ctx = this.animContext(run, opts.speed ?? 1);
    const takenBySquare = new Map(captured.map((sq, i) => [sq, taken[i]]));

    const start = this.pieces.currentPose(mover);
    start.y += mover.lift;
    mover.lift = 0;
    mover.top.visible = wasKing;
    this.stage.invalidate();

    const first = continuing ? fromHop : 0;
    const jump = captured.length > 0;
    let from = start;
    const resume = squarePose(move.path[first]);
    if (Math.hypot(from.x - resume.x, from.z - resume.z) > 0.01) {
      await hop(ctx, mover, from, resume, JUMP_HOP.height / 2, JUMP_HOP.ms / 2);
      if (run.cancelled) return;
      from = resume;
    }
    for (let i = first; i + 1 < move.path.length; i++) {
      const to = squarePose(move.path[i + 1]);
      const spec = jump ? JUMP_HOP : QUIET_HOP;
      await hop(ctx, mover, from, to, spec.height, spec.ms);
      if (run.cancelled) return;
      if (jump) {
        const victim = takenBySquare.get(jumpedSquares([move.path[i], move.path[i + 1]])[0]);
        if (victim) this.pieces.setPending(victim, true);
      }
      from = to;
    }
    await squash(ctx, mover);
    if (run.cancelled) return;
    await Promise.all(taken.map((e, i) => flyToTray(ctx, e, i)));
    if (run.cancelled) return;
    if (move.promotes && !wasKing) await crownDrop(ctx, mover);
    if (run.cancelled) return;
    this.pieces.snapAll();
    this.applyPendingTint();
    this.applyLift(false);
    this.stage.markShadowsDirty();
  }

  async previewHop(from: Sq, to: Sq, captured: Sq | null): Promise<void> {
    let preview = this.preview;
    const run = this.restartPreviewMotion();
    if (!preview || preview.at !== from) {
      this.clearPreview();
      const entity = this.pieces.entityAt(from);
      if (!entity) return;
      preview = { entity, origin: from, at: from, captured: [] };
      this.preview = preview;
    }
    const ctx = this.animContext(run, 1);
    const e = preview.entity;
    const start = this.pieces.currentPose(e);
    preview.at = to;
    const victim = captured === null ? undefined : this.pieces.entityAt(captured);
    const spec = captured === null ? QUIET_HOP : JUMP_HOP;
    this.stage.invalidate();
    await hop(ctx, e, start, squarePose(to), spec.height, spec.ms);
    if (victim && this.preview === preview) {
      preview.captured.push(victim);
      this.pieces.setPending(victim, true);
    }
    this.stage.markShadowsDirty();
  }

  cancelPreview(): void {
    const preview = this.preview;
    if (!preview) return;
    this.preview = null;
    const run = this.restartPreviewMotion();
    const e = preview.entity;
    this.returning = e;
    const from = this.pieces.currentPose(e);
    this.applyPendingTint();
    this.stage.invalidate();
    void hop(this.animContext(run, 1), e, from, this.pieces.restPose(e), 0.2, 220).then(() => {
      if (this.returning === e && !run.cancelled) this.returning = null;
      this.stage.markShadowsDirty();
    });
  }

  /** Cancels any in-flight preview or return hop; a piece cut off mid-return lands on its square. */
  private restartPreviewMotion(): Run {
    this.previewRun.cancelled = true;
    this.stage.tweens.cancel(this.previewRun);
    this.previewRun = new Run();
    if (this.returning) {
      this.pieces.snap(this.returning);
      this.returning = null;
    }
    return this.previewRun;
  }


  setHighlights(h: Highlights): void {
    this.highlights = h;
    this.highlightLayer.set(h);
    this.applyPendingTint();
    this.applyLift(true);
    this.stage.invalidate();
  }

  private applyPendingTint(): void {
    const pending = new Set<PieceEntity>(this.preview?.captured ?? []);
    for (const sq of this.highlights.pending ?? []) {
      const e = this.pieces.entityAt(sq);
      if (e) pending.add(e);
    }
    for (const e of this.pieces.entities) this.pieces.setPending(e, pending.has(e));
  }

  private applyLift(animate: boolean): void {
    const selected = this.highlights.selected ?? null;
    for (const e of this.pieces.entities) {
      const want = e.sq !== null && e.sq === selected && this.preview?.entity !== e ? LIFT_HEIGHT : 0;
      if (Math.abs(e.lift - want) < 1e-4) continue;
      const startLift = e.lift;
      const set = (lift: number) => {
        e.group.position.y += lift - e.lift;
        e.lift = lift;
      };
      if (!animate) {
        set(want);
        continue;
      }
      void this.stage.tweens.add(LIFT_MS, (t) => set(lerp(startLift, want, t)), { ease: easeOutCubic });
    }
    this.stage.markShadowsDirty();
  }


  async setOrientation(side: Side, animate: boolean): Promise<void> {
    this.pieces.setViewerSide(side);
    await this.stage.orient(side, animate && !this.reducedMotion.matches);
  }

  setBoardSlot(el: HTMLElement | null): void {
    this.stage.setSlot(el);
  }

  setVisible(visible: boolean): void {
    this.stage.setVisible(visible);
  }

  setInstantAnimations(instant: boolean): void {
    this.stage.tweens.instant = instant;
    if (instant) {
      this.interrupt();
      this.applyLift(false);
    }
  }


  squareAtClient(x: number, y: number): Sq | null {
    this.stage.camera.updateMatrixWorld();
    return pickAt(this.stage.camera, this.stage.canvasClientRect, x, y, (sq) => this.pieces.surfaceAt(sq), PICK_LEVELS);
  }

  clientOfSquare(sq: Sq): { x: number; y: number } {
    this.stage.camera.updateMatrixWorld();
    return projectSquare(this.stage.camera, this.stage.canvasClientRect, sq, (s) => this.pieces.surfaceAt(s));
  }

  onSquareTap(fn: (sq: Sq | null) => void): () => void {
    this.tapListeners.add(fn);
    return () => this.tapListeners.delete(fn);
  }

  private isActionable(sq: Sq | null): boolean {
    if (sq === null) return false;
    const h = this.highlights;
    return (
      h.selected === sq ||
      (h.movable ?? []).includes(sq) ||
      (h.targets ?? []).includes(sq) ||
      (h.captureTargets ?? []).includes(sq)
    );
  }

  private installPointerHandling(): void {
    const canvas = this.stage.canvas;
    const onDown = (ev: PointerEvent) => {
      if (ev.target !== canvas) return;
      const tap = ev.pointerType !== 'mouse' || ev.button === 0;
      this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, t: performance.now(), tap });
      if (this.pointers.size > 1) for (const p of this.pointers.values()) p.tap = false;
      if (ev.pointerType === 'mouse' && ev.button === 0 && this.isActionable(this.squareAtClient(ev.clientX, ev.clientY))) {
        ev.stopPropagation();
      }
    };
    const onMove = (ev: PointerEvent) => {
      const p = this.pointers.get(ev.pointerId);
      if (p && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > TAP_SLOP_PX) p.tap = false;
      if (!p && ev.pointerType === 'mouse' && ev.target === canvas && ev.buttons === 0) {
        canvas.style.cursor = this.isActionable(this.squareAtClient(ev.clientX, ev.clientY)) ? 'pointer' : 'grab';
      }
    };
    const onUp = (ev: PointerEvent) => {
      const p = this.pointers.get(ev.pointerId);
      if (!p) return;
      this.pointers.delete(ev.pointerId);
      if (!p.tap || performance.now() - p.t > TAP_MAX_MS || this.pointers.size > 0) return;
      const sq = this.squareAtClient(p.x, p.y);
      for (const fn of [...this.tapListeners]) fn(sq);
    };
    const onCancel = (ev: PointerEvent) => {
      this.pointers.delete(ev.pointerId);
    };
    this.host.addEventListener('pointerdown', onDown, { capture: true });
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    this.cleanups.push(
      () => this.host.removeEventListener('pointerdown', onDown, { capture: true }),
      () => window.removeEventListener('pointermove', onMove),
      () => window.removeEventListener('pointerup', onUp),
      () => window.removeEventListener('pointercancel', onCancel),
    );
  }


  setQuality(pref: QualityPref): void {
    this.pref = pref;
    const tier = pref === 'auto' ? (readStoredTier() ?? this.tier) : pref;
    this.stage.setGovernorEnabled(pref === 'auto' && tier === 'high');
    this.applyTier(tier);
  }

  private downgrade(): void {
    if (this.disposed || this.tier === 'low') return;
    storeTier('low');
    this.applyTier('low');
  }

  private applyTier(tier: QualityTier): void {
    if (tier === this.tier) return;
    this.tier = tier;
    const spec = TIERS[tier];
    this.stage.setDprCap(spec.dprCap);
    this.lighting.setShadowQuality(spec.shadowMapSize, spec.shadowRadius);
    this.board.setMaterialTier(spec.physical);
    const old = this.pieceModel;
    const anisotropy = Math.min(8, this.stage.renderer.capabilities.getMaxAnisotropy());
    this.pieceModel = createPieceModel({ segments: spec.latheSegments, physical: spec.physical, anisotropy });
    this.pieces.setModel(this.pieceModel);
    old.dispose();
    this.stage.markShadowsDirty();
  }

  stats(): BoardViewStats {
    return { ...this.stage.stats, tier: this.tier };
  }


  /** Stops the running piece animation; by default snaps every piece to its model pose. */
  private interrupt(snap = true): Run {
    this.run.cancelled = true;
    this.stage.tweens.cancel(this.run);
    this.run = new Run();
    this.restartPreviewMotion();
    if (snap) {
      this.pieces.snapAll();
      this.applyPendingTint();
      this.stage.markShadowsDirty();
    }
    return this.run;
  }

  private clearPreview(snap = true): void {
    const preview = this.preview;
    this.preview = null;
    if (!preview) return;
    if (snap) this.pieces.snap(preview.entity);
    this.applyPendingTint();
  }

  private animContext(run: Run, speed: number): AnimContext {
    return { pieces: this.pieces, tweens: this.stage.tweens, run, motion: this.motion, speed };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.interrupt(false);
    for (const c of this.cleanups) c();
    this.tapListeners.clear();
    this.highlightLayer.dispose();
    this.board.dispose();
    this.pieceModel.dispose();
    for (const t of Object.values(this.highlightTextures)) t.dispose();
    this.lighting.dispose();
    this.stage.dispose();
  }
}

export async function createBoardViewExt(host: HTMLElement, opts: BoardViewExtOptions = {}): Promise<BoardViewExt> {
  const view = new BoardViewImpl(host, opts);
  await view.warmUp();
  return view;
}

export const createBoardView: CreateBoardView = createBoardViewExt;
