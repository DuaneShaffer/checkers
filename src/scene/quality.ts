export type QualityTier = 'high' | 'low';
export type QualityPref = 'auto' | QualityTier;

export interface TierSpec {
  dprCap: number;
  shadowMapSize: number;
  shadowRadius: number;
  physical: boolean;
  latheSegments: number;
  fieldTextureSize: number;
}

export const TIERS: Record<QualityTier, TierSpec> = {
  high: { dprCap: 2, shadowMapSize: 2048, shadowRadius: 4, physical: true, latheSegments: 64, fieldTextureSize: 1024 },
  low: { dprCap: 1.25, shadowMapSize: 1024, shadowRadius: 2, physical: false, latheSegments: 36, fieldTextureSize: 512 },
};

const STORAGE_KEY = 'checkers:gfx-tier';
const STORED_TIER_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export interface DeviceHints {
  coarsePointer: boolean;
  deviceMemory?: number;
  cores?: number;
}

export function heuristicTier(h: DeviceHints): QualityTier {
  if ((h.deviceMemory ?? 8) <= 3) return 'low';
  if (h.coarsePointer && (h.cores ?? 8) <= 4) return 'low';
  return 'high';
}

export function initialTier(pref: QualityPref, hints: DeviceHints, stored: QualityTier | null): QualityTier {
  if (pref !== 'auto') return pref;
  return stored ?? heuristicTier(hints);
}

export function readDeviceHints(): DeviceHints {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    coarsePointer: matchMedia('(pointer: coarse)').matches,
    deviceMemory: nav.deviceMemory,
    cores: nav.hardwareConcurrency,
  };
}

/** A downgrade is remembered for a few days so a temporary throttle (low-power mode) cannot pin the low tier forever. */
export function parseStoredTier(raw: string | null, now: number): QualityTier | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { tier?: unknown; at?: unknown };
    if ((v.tier !== 'low' && v.tier !== 'high') || typeof v.at !== 'number') return null;
    return now - v.at < STORED_TIER_TTL_MS ? v.tier : null;
  } catch {
    return null;
  }
}

export function readStoredTier(): QualityTier | null {
  try {
    return parseStoredTier(localStorage.getItem(STORAGE_KEY), Date.now());
  } catch {
    return null;
  }
}

export function storeTier(tier: QualityTier): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tier, at: Date.now() }));
  } catch {
    /* storage unavailable: the downgrade just won't persist */
  }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export interface GovernorLimits {
  window: number;
  /** Most frames slower than this is too slow, however the display is paced. */
  medianIntervalMs: number;
  /** Frequent drops must exceed this and `dropFactor` times the display cadence. */
  dropIntervalMs: number;
  dropFactor: number;
  /** CPU cost of tick + render; catches a CPU-bound device even under a throttled refresh. */
  workMs: number;
}

export const GOVERNOR_LIMITS: GovernorLimits = {
  window: 90,
  medianIntervalMs: 40,
  dropIntervalMs: 28,
  dropFactor: 1.6,
  workMs: 22,
};

/**
 * Watches continuous rendering and asks for one downgrade when frames are genuinely slow.
 * The fastest intervals approximate the display cadence, so a steady 30 Hz cap (iOS Low Power
 * Mode, Chrome Energy Saver) or an occasional dropped frame does not count as slow.
 */
export class FrameGovernor {
  private intervals: number[] = [];
  private work: number[] = [];
  private readonly limits: GovernorLimits;

  constructor(limits: Partial<GovernorLimits> = {}) {
    this.limits = { ...GOVERNOR_LIMITS, ...limits };
  }

  sample(intervalMs: number, workMs: number): boolean {
    this.intervals.push(intervalMs);
    this.work.push(workMs);
    if (this.intervals.length < this.limits.window) return false;
    const verdict = this.isSlow();
    this.reset();
    return verdict;
  }

  private isSlow(): boolean {
    const l = this.limits;
    const cadence = percentile(this.intervals, 0.1);
    const mostlySlow = percentile(this.intervals, 0.5) > l.medianIntervalMs;
    const oftenDropping = percentile(this.intervals, 0.75) > Math.max(l.dropIntervalMs, cadence * l.dropFactor);
    const heavyWork = percentile(this.work, 0.75) > l.workMs;
    return mostlySlow || oftenDropping || heavyWork;
  }

  reset(): void {
    this.intervals = [];
    this.work = [];
  }
}
