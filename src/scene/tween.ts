export type Ease = (t: number) => number;

export const linear: Ease = (t) => t;
export const easeInOutCubic: Ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const easeOutCubic: Ease = (t) => 1 - (1 - t) ** 3;
export const easeInCubic: Ease = (t) => t * t * t;
export const easeOutBack: Ease = (t) => {
  const c = 1.4;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
};
export const easeOutBounce: Ease = (t) => {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};

/** A cancellable animation sequence; tweens started on a cancelled run resolve immediately. */
export class Run {
  cancelled = false;
}

interface Active {
  run: Run | null;
  delay: number;
  duration: number;
  elapsed: number;
  ease: Ease;
  update: (t: number) => void;
  resolve: () => void;
}

export class Tweens {
  instant = false;
  /** Multiplies every duration; prefers-reduced-motion sets it. Per-animation speed is AnimContext.speed. */
  timeScale = 1;
  /** Called whenever a tween is queued, so an idle render loop can restart. */
  onWake: () => void = () => {};
  private active: Active[] = [];

  get busy(): boolean {
    return this.active.length > 0;
  }

  add(duration: number, update: (t: number) => void, opts: { ease?: Ease; delay?: number; run?: Run } = {}): Promise<void> {
    const run = opts.run ?? null;
    if (run?.cancelled) return Promise.resolve();
    const scaled = this.instant ? 0 : Math.max(0, duration * this.timeScale);
    const delay = this.instant ? 0 : Math.max(0, (opts.delay ?? 0) * this.timeScale);
    const ease = opts.ease ?? easeInOutCubic;
    if (scaled === 0 && delay === 0) {
      update(1);
      this.onWake();
      return Promise.resolve();
    }
    const done = new Promise<void>((resolve) => {
      this.active.push({ run, delay, duration: scaled, elapsed: 0, ease, update, resolve });
    });
    this.onWake();
    return done;
  }

  wait(ms: number, run?: Run): Promise<void> {
    return this.add(ms, () => {}, { ease: linear, run });
  }

  /** Advances all tweens; returns true while any remain. */
  tick(dtMs: number): boolean {
    if (this.active.length === 0) return false;
    const done: Active[] = [];
    for (const a of this.active) {
      if (a.run?.cancelled) {
        done.push(a);
        continue;
      }
      a.elapsed += dtMs;
      const t = a.elapsed - a.delay;
      if (t < 0) continue;
      const k = a.duration === 0 ? 1 : Math.min(1, t / a.duration);
      a.update(a.ease(k));
      if (k >= 1) done.push(a);
    }
    if (done.length > 0) {
      this.active = this.active.filter((a) => !done.includes(a));
      for (const a of done) a.resolve();
    }
    return this.active.length > 0;
  }

  /** Drops every tween belonging to `run` (or all tweens) without applying final values. */
  cancel(run?: Run): void {
    const dropped = run ? this.active.filter((a) => a.run === run) : this.active;
    this.active = run ? this.active.filter((a) => a.run !== run) : [];
    for (const a of dropped) a.resolve();
  }
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
