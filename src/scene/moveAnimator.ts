import { PIECE_HEIGHT } from './dims.ts';
import type { PieceEntity, Pieces, Pose } from './pieces.ts';
import { easeInOutCubic, easeOutBounce, easeOutCubic, lerp, linear, type Run, type Tweens } from './tween.ts';

export interface Motion {
  /** 1 normally; small under prefers-reduced-motion so pieces glide rather than leap. */
  arc: number;
}

export interface AnimContext {
  pieces: Pieces;
  tweens: Tweens;
  run: Run;
  motion: Motion;
  speed: number;
}

export const QUIET_HOP = { height: 0.24, ms: 280 };
export const JUMP_HOP = { height: 0.6, ms: 340 };
const TRAY_FLIGHT = { height: 1.1, ms: 460, stagger: 80 };
const CROWN_DROP = { from: 1.3, ms: 420 };
const SQUASH_MS = 110;

export function hop(ctx: AnimContext, e: PieceEntity, from: Pose, to: Pose, height: number, ms: number, delay = 0): Promise<void> {
  const h = height * ctx.motion.arc;
  return ctx.tweens.add(
    ms / ctx.speed,
    (t) => {
      ctx.pieces.setPose(e, {
        x: lerp(from.x, to.x, t),
        y: lerp(from.y, to.y, t) + 4 * h * t * (1 - t),
        z: lerp(from.z, to.z, t),
        scale: lerp(from.scale, to.scale, t),
      });
    },
    { run: ctx.run, ease: easeInOutCubic, delay: delay / ctx.speed },
  );
}

export function squash(ctx: AnimContext, e: PieceEntity): Promise<void> {
  return ctx.tweens.add(
    SQUASH_MS / ctx.speed,
    (t) => {
      const s = 1 - 0.07 * Math.sin(Math.PI * t);
      e.group.scale.set(1 / Math.sqrt(s), s, 1 / Math.sqrt(s));
      if (t >= 1) e.group.scale.setScalar(1);
    },
    { run: ctx.run, ease: linear },
  );
}

export function flyToTray(ctx: AnimContext, e: PieceEntity, index: number): Promise<void> {
  const from = ctx.pieces.currentPose(e);
  const to = ctx.pieces.restPose(e);
  e.top.visible = false;
  ctx.pieces.setPending(e, false);
  return hop(ctx, e, from, to, TRAY_FLIGHT.height, TRAY_FLIGHT.ms, index * TRAY_FLIGHT.stagger);
}

export function crownDrop(ctx: AnimContext, e: PieceEntity): Promise<void> {
  e.top.visible = true;
  const from = CROWN_DROP.from * Math.max(0.35, ctx.motion.arc);
  return ctx.tweens.add(
    CROWN_DROP.ms / ctx.speed,
    (t) => {
      e.top.position.y = lerp(PIECE_HEIGHT + from, PIECE_HEIGHT, t);
    },
    { run: ctx.run, ease: ctx.motion.arc < 1 ? easeOutCubic : easeOutBounce },
  );
}

export function popIn(ctx: AnimContext, e: PieceEntity, ms: number): Promise<void> {
  const rest = ctx.pieces.restPose(e);
  return ctx.tweens.add(
    ms / ctx.speed,
    (t) => ctx.pieces.setPose(e, { ...rest, scale: rest.scale * t }),
    { run: ctx.run, ease: easeOutCubic },
  );
}
