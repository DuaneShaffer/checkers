import { NeutralToneMapping, PCFShadowMap, Scene, Spherical, TOUCH, Vector3, WebGLRenderer, type PerspectiveCamera } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Side } from '../engine/types.ts';
import {
  applySlotProjection,
  homeAzimuth,
  homeFraming,
  newCamera,
  placeCamera,
  type Framing,
  type Pose,
  type Rect,
} from './cameraRig.ts';
import type { TrayLayout } from './dims.ts';
import { FrameGovernor } from './quality.ts';
import { Run, Tweens, easeInOutCubic, lerp } from './tween.ts';

const AZIMUTH_SWING = 0.7;
const MIN_POLAR = 0.1;
const MAX_POLAR = 1.12;
const ORIENT_MS = 750;
const RECENTER_MS = 520;

export interface StageOptions {
  antialias: boolean;
  testMode: boolean;
  dprCap: number;
}

export interface StageHooks {
  onLayout(layout: TrayLayout): void;
  onSlowFrames(): void;
  onContextRestored(): void;
}

function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class Stage {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera = newCamera();
  readonly controls: OrbitControls;
  readonly tweens = new Tweens();
  readonly canvas: HTMLCanvasElement;

  private readonly host: HTMLElement;
  private readonly hooks: StageHooks;
  private readonly testMode: boolean;
  private dprCap: number;
  private slotEl: HTMLElement | null = null;
  private canvasRect: Rect = { left: 0, top: 0, width: 0, height: 0 };
  private slotRect: Rect = { left: 0, top: 0, width: 0, height: 0 };
  private framing: Framing | null = null;
  private side: Side = 0;
  private layout: TrayLayout = 'ends';
  private rafId = 0;
  private lastFrame = 0;
  private visible = true;
  private shadowDirty = true;
  private interacting = false;
  private cameraBusy = false;
  private cameraRun: Run | null = null;
  private governor = new FrameGovernor();
  private governorEnabled = true;
  private renderCount = 0;
  private readonly resizeObserver: ResizeObserver;
  private readonly cleanups: (() => void)[] = [];

  constructor(host: HTMLElement, opts: StageOptions, hooks: StageHooks) {
    this.host = host;
    this.hooks = hooks;
    this.testMode = opts.testMode;
    this.dprCap = opts.dprCap;
    this.governorEnabled = !opts.testMode;
    this.tweens.onWake = () => this.invalidate();

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'board-canvas';
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none', outline: 'none' });
    this.canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(this.canvas);

    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: opts.antialias,
      alpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: opts.testMode,
    });
    this.renderer.debug.checkShaderErrors = opts.testMode;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.7;
    this.controls.minPolarAngle = MIN_POLAR;
    this.controls.maxPolarAngle = MAX_POLAR;
    this.controls.touches = { ONE: null, TWO: TOUCH.DOLLY_ROTATE };
    this.controls.addEventListener('change', () => this.invalidate());
    this.controls.addEventListener('start', () => {
      this.interacting = true;
      this.invalidate();
    });
    this.controls.addEventListener('end', () => {
      this.interacting = false;
      this.invalidate();
    });

    this.resizeObserver = new ResizeObserver(() => this.relayout());
    this.resizeObserver.observe(host);
    const onWindowResize = () => this.relayout();
    window.addEventListener('resize', onWindowResize);
    window.visualViewport?.addEventListener('resize', onWindowResize);
    const onVisibility = () => {
      if (!document.hidden) this.invalidate();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const onLost = (ev: Event) => ev.preventDefault();
    const onRestored = () => {
      this.hooks.onContextRestored();
      this.shadowDirty = true;
      this.invalidate();
    };
    this.canvas.addEventListener('webglcontextlost', onLost);
    this.canvas.addEventListener('webglcontextrestored', onRestored);
    this.cleanups.push(
      () => window.removeEventListener('resize', onWindowResize),
      () => window.visualViewport?.removeEventListener('resize', onWindowResize),
      () => document.removeEventListener('visibilitychange', onVisibility),
      () => this.canvas.removeEventListener('webglcontextlost', onLost),
      () => this.canvas.removeEventListener('webglcontextrestored', onRestored),
    );
    this.measure();
  }

  get stats(): { renders: number; animating: boolean } {
    return { renders: this.renderCount, animating: this.tweens.busy || this.interacting || this.cameraBusy };
  }

  get canvasClientRect(): Rect {
    const r = this.canvas.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  get trayLayout(): TrayLayout {
    return this.layout;
  }

  get viewerSide(): Side {
    return this.side;
  }

  setDprCap(cap: number): void {
    this.dprCap = cap;
    this.relayout();
  }

  markShadowsDirty(): void {
    this.shadowDirty = true;
    this.invalidate();
  }

  setSlot(el: HTMLElement | null): void {
    if (this.slotEl) this.resizeObserver.unobserve(this.slotEl);
    this.slotEl = el;
    if (el) this.resizeObserver.observe(el);
    this.relayout();
    requestAnimationFrame(() => this.relayout());
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.canvas.style.visibility = visible ? 'visible' : 'hidden';
    if (visible) this.relayout();
    else if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  invalidate(): void {
    if (!this.visible || this.rafId) return;
    this.rafId = requestAnimationFrame(this.frame);
  }

  /** Re-measures synchronously and renders immediately so a resize never shows a stretched frame. */
  relayout(): void {
    if (!this.visible) return;
    this.measure();
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.frame(performance.now());
  }

  private measure(): void {
    const host = this.host.getBoundingClientRect();
    const w = Math.round(host.width);
    const h = Math.round(host.height);
    if (w === 0 || h === 0) return;
    const dpr = this.testMode ? 1 : Math.min(window.devicePixelRatio || 1, this.dprCap);
    const sizeChanged = w !== this.canvasRect.width || h !== this.canvasRect.height || this.renderer.getPixelRatio() !== dpr;
    if (sizeChanged) {
      this.renderer.setPixelRatio(dpr);
      this.renderer.setSize(w, h, false);
    }
    const slot = this.slotEl?.getBoundingClientRect();
    const slotRect: Rect =
      slot && slot.width > 1 && slot.height > 1
        ? { left: slot.left - host.left, top: slot.top - host.top, width: slot.width, height: slot.height }
        : { left: 0, top: 0, width: w, height: h };
    const slotChanged =
      sizeChanged ||
      !this.framing ||
      Math.abs(slotRect.left - this.slotRect.left) > 0.5 ||
      Math.abs(slotRect.top - this.slotRect.top) > 0.5 ||
      Math.abs(slotRect.width - this.slotRect.width) > 0.5 ||
      Math.abs(slotRect.height - this.slotRect.height) > 0.5;
    this.canvasRect = { left: host.left, top: host.top, width: w, height: h };
    if (!slotChanged) return;
    this.slotRect = slotRect;
    this.reframe();
  }

  private reframe(): void {
    const { width, height } = this.slotRect;
    const prev = this.framing;
    const next = homeFraming(width, height, this.side);
    if (next.layout !== this.layout) {
      this.layout = next.layout;
      this.hooks.onLayout(next.layout);
      this.shadowDirty = true;
    }
    const userPose = prev && !this.cameraBusy ? this.currentPose() : null;
    this.framing = next;
    this.applyLimits();
    applySlotProjection(this.camera, this.canvasRect.width, this.canvasRect.height, this.slotRect, next.center);
    if (this.cameraBusy) return;
    const atHome = !prev || !userPose || this.isNear(userPose, prev.pose);
    const pose = atHome
      ? next.pose
      : { ...userPose, distance: (userPose.distance * next.pose.distance) / prev.pose.distance };
    this.setCameraPose(pose);
  }

  private isNear(a: Pose, b: Pose): boolean {
    return Math.abs(angleDelta(a.azimuth, b.azimuth)) < 0.01 && Math.abs(a.polar - b.polar) < 0.01 && Math.abs(a.distance / b.distance - 1) < 0.01;
  }

  private applyLimits(): void {
    if (!this.framing) return;
    const home = homeAzimuth(this.side);
    const d = this.framing.pose.distance;
    this.controls.minDistance = d * 0.72;
    this.controls.maxDistance = d * 1.45;
    this.controls.minAzimuthAngle = home - AZIMUTH_SWING;
    this.controls.maxAzimuthAngle = home + AZIMUTH_SWING;
  }

  currentPose(): Pose {
    const s = new Spherical().setFromVector3(new Vector3().copy(this.camera.position).sub(this.controls.target));
    return { polar: s.phi, azimuth: s.theta, distance: s.radius };
  }

  private setCameraPose(pose: Pose): void {
    this.controls.target.set(0, 0, 0);
    placeCamera(this.camera, pose);
    this.controls.update();
  }

  /** Tweens to `side`'s home view; with the current side this is "recenter". */
  async orient(side: Side, animate: boolean): Promise<void> {
    const flipping = side !== this.side;
    this.side = side;
    if (!this.framing) {
      this.relayout();
      return;
    }
    const next = homeFraming(this.slotRect.width, this.slotRect.height, side);
    this.framing = next;
    applySlotProjection(this.camera, this.canvasRect.width, this.canvasRect.height, this.slotRect, next.center);
    const from = this.currentPose();
    const to = next.pose;
    if (!animate || this.tweens.instant) {
      this.stopCameraTween();
      this.applyLimits();
      this.setCameraPose(to);
      this.invalidate();
      return;
    }
    let dAz = angleDelta(from.azimuth, to.azimuth);
    if (flipping && Math.abs(Math.abs(dAz) - Math.PI) < 0.35) dAz = Math.abs(dAz);
    this.stopCameraTween();
    const run = new Run();
    this.cameraRun = run;
    this.cameraBusy = true;
    this.controls.enabled = false;
    this.controls.minAzimuthAngle = -Infinity;
    this.controls.maxAzimuthAngle = Infinity;
    await this.tweens.add(
      flipping ? ORIENT_MS : RECENTER_MS,
      (t) => {
        const swoop = flipping ? Math.sin(Math.PI * t) : 0;
        placeCamera(this.camera, {
          polar: lerp(from.polar, to.polar, t) - swoop * 0.18,
          azimuth: from.azimuth + dAz * t,
          distance: lerp(from.distance, to.distance, t) * (1 + swoop * 0.06),
        });
      },
      { ease: easeInOutCubic, run },
    );
    if (this.cameraRun !== run) return;
    this.cameraRun = null;
    this.cameraBusy = false;
    this.controls.enabled = true;
    this.applyLimits();
    this.setCameraPose(this.framing?.pose ?? to);
    this.invalidate();
  }

  private stopCameraTween(): void {
    if (!this.cameraRun) return;
    this.cameraRun.cancelled = true;
    this.tweens.cancel(this.cameraRun);
    this.cameraRun = null;
    this.cameraBusy = false;
    this.controls.enabled = true;
  }

  setGovernorEnabled(enabled: boolean): void {
    this.governorEnabled = enabled && !this.testMode;
  }

  private frame = (now: number): void => {
    this.rafId = 0;
    if (!this.visible || document.hidden) {
      this.lastFrame = 0;
      return;
    }
    const workStart = performance.now();
    const continuing = this.lastFrame !== 0;
    const dt = continuing ? Math.min(100, now - this.lastFrame) : 16;
    const animating = this.tweens.tick(dt);
    const controlsMoving = this.cameraBusy ? false : this.controls.update();
    if (animating || this.shadowDirty) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowDirty = false;
    }
    if (this.canvasRect.width > 0) {
      this.renderer.render(this.scene, this.camera);
      this.renderCount++;
    }
    const keepGoing = animating || this.tweens.busy || controlsMoving || this.interacting || this.cameraBusy;
    if (keepGoing) {
      if (continuing && this.governorEnabled && this.governor.sample(dt, performance.now() - workStart)) {
        this.governorEnabled = false;
        queueMicrotask(() => this.hooks.onSlowFrames());
      }
      this.lastFrame = now;
      this.rafId = requestAnimationFrame(this.frame);
    } else {
      this.lastFrame = 0;
    }
  };

  dispose(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.visible = false;
    this.tweens.cancel();
    this.resizeObserver.disconnect();
    for (const c of this.cleanups) c();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
