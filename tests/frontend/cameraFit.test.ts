import { describe, expect, it } from 'vitest';
import type { Side } from '../../src/engine/types.ts';
import {
  FIT_PADDING,
  applySlotProjection,
  fitToSlot,
  homeFraming,
  newCamera,
  placeCamera,
  polarForAspect,
  projectToCanvas,
  type Rect,
} from '../../src/scene/cameraRig.ts';
import { framingPoints } from '../../src/scene/dims.ts';
import { FrameGovernor, GOVERNOR_LIMITS, parseStoredTier } from '../../src/scene/quality.ts';

interface Case {
  name: string;
  canvas: { w: number; h: number };
  slot: Rect;
}

const CASES: Case[] = [
  { name: '360x640 portrait, HUD top and bottom', canvas: { w: 360, h: 640 }, slot: { left: 0, top: 96, width: 360, height: 420 } },
  { name: '390x844 portrait', canvas: { w: 390, h: 844 }, slot: { left: 8, top: 120, width: 374, height: 560 } },
  { name: '844x390 landscape phone with rails', canvas: { w: 844, h: 390 }, slot: { left: 150, top: 8, width: 520, height: 374 } },
  { name: '1440x900 desktop with side panel', canvas: { w: 1440, h: 900 }, slot: { left: 24, top: 24, width: 1020, height: 852 } },
  { name: 'full canvas', canvas: { w: 1000, h: 700 }, slot: { left: 0, top: 0, width: 1000, height: 700 } },
];

function framedBounds(c: Case, side: Side) {
  const camera = newCamera();
  const framing = homeFraming(c.slot.width, c.slot.height, side);
  placeCamera(camera, framing.pose);
  applySlotProjection(camera, c.canvas.w, c.canvas.h, c.slot, framing.center);
  const pts = framingPoints(framing.layout).map((p) =>
    projectToCanvas(camera, p, c.canvas.w, c.canvas.h),
  );
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

describe('camera fit to the board slot', () => {
  for (const c of CASES) {
    for (const side of [0, 1] as Side[]) {
      it(`${c.name}, side ${side}: board stays inside the slot and fills it`, () => {
        const b = framedBounds(c, side);
        const eps = 0.5;
        const { left, top, width, height } = c.slot;
        expect(b.minX).toBeGreaterThanOrEqual(left - eps);
        expect(b.maxX).toBeLessThanOrEqual(left + width + eps);
        expect(b.minY).toBeGreaterThanOrEqual(top - eps);
        expect(b.maxY).toBeLessThanOrEqual(top + height + eps);

        const fillX = (b.maxX - b.minX) / width;
        const fillY = (b.maxY - b.minY) / height;
        expect(Math.max(fillX, fillY)).toBeCloseTo(1 - FIT_PADDING, 2);

        const cx = (b.minX + b.maxX) / 2;
        const cy = (b.minY + b.maxY) / 2;
        expect(cx).toBeCloseTo(left + width / 2, 0);
        expect(cy).toBeCloseTo(top + height / 2, 0);
      });
    }
  }

  it('looks more top-down in portrait than in landscape', () => {
    expect(polarForAspect(0.6)).toBeLessThan(polarForAspect(1));
    expect(polarForAspect(1)).toBeLessThan(polarForAspect(1.6));
    expect(polarForAspect(0.3)).toBeCloseTo(polarForAspect(0.5));
  });

  it('moves the capture trays to the long axis of the slot', () => {
    expect(homeFraming(360, 600, 0).layout).toBe('ends');
    expect(homeFraming(900, 500, 0).layout).toBe('sides');
    expect(homeFraming(900, 500, 1).layout).toBe('sides');
  });

  it('picks the tray layout that leaves the board largest', () => {
    for (const [w, h] of [[400, 700], [800, 800], [1065, 900], [900, 520]]) {
      const chosen = homeFraming(w, h, 0);
      const aspect = w / h;
      const other = fitToSlot(aspect, polarForAspect(aspect), Math.PI, framingPoints(chosen.layout === 'ends' ? 'sides' : 'ends'));
      expect(chosen.pose.distance).toBeLessThanOrEqual(other.pose.distance);
    }
  });

  it('gives the board a usable size on a small phone', () => {
    const c = CASES[0];
    const b = framedBounds(c, 0);
    const boardWidthPx = b.maxX - b.minX;
    expect(boardWidthPx).toBeGreaterThan(c.slot.width * 0.9);
  });
});

describe('FrameGovernor', () => {
  const verdict = (interval: (i: number) => number, work = () => 2): boolean => {
    const g = new FrameGovernor();
    let slow = false;
    for (let i = 0; i < GOVERNOR_LIMITS.window; i++) slow = g.sample(interval(i), work()) || slow;
    return slow;
  };

  it('accepts a steady 30 Hz refresh cap (low-power modes)', () => {
    expect(verdict(() => 1000 / 30)).toBe(false);
  });

  it('accepts a 60 Hz display that drops every fifth frame', () => {
    expect(verdict((i) => (i % 5 === 4 ? 34 : 16.7))).toBe(false);
  });

  it('accepts 120 Hz and 60 Hz with jitter', () => {
    expect(verdict((i) => 8.3 + (i % 3))).toBe(false);
    expect(verdict((i) => 16.7 + (i % 4))).toBe(false);
  });

  it('downgrades when a 60 Hz display drops every other frame', () => {
    expect(verdict((i) => (i % 2 ? 33.3 : 16.7))).toBe(true);
  });

  it('downgrades a sustained sub-25 fps cadence even when it is steady', () => {
    expect(verdict(() => 50)).toBe(true);
  });

  it('downgrades when frame work alone is too heavy', () => {
    expect(verdict(() => 1000 / 30, () => 26)).toBe(true);
  });

  it('decides once per window', () => {
    const g = new FrameGovernor({ window: 4 });
    expect([1, 2, 3].map(() => g.sample(60, 1))).toEqual([false, false, false]);
    expect(g.sample(60, 1)).toBe(true);
    expect(g.sample(60, 1)).toBe(false);
  });
});

describe('stored quality tier', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 100 * day;

  it('remembers a recent downgrade', () => {
    expect(parseStoredTier(JSON.stringify({ tier: 'low', at: now - day }), now)).toBe('low');
  });

  it('forgets a downgrade after a few days', () => {
    expect(parseStoredTier(JSON.stringify({ tier: 'low', at: now - 4 * day }), now)).toBeNull();
  });

  it('ignores legacy and malformed values', () => {
    for (const raw of [null, 'low', 'high', '{', '{"tier":"ultra","at":0}', '{"tier":"low"}']) {
      expect(parseStoredTier(raw, now)).toBeNull();
    }
  });
});
