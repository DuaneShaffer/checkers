export type HapticName = 'select' | 'move' | 'capture' | 'crown' | 'illegal';

const PATTERNS: Record<HapticName, number | number[]> = {
  select: 8,
  move: 15,
  capture: [25, 35, 25],
  crown: [15, 30, 15, 30, 60],
  illegal: 40,
};

let enabled = true;

export function setHapticsEnabled(on: boolean): void {
  enabled = on;
}

export function hapticsSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

export function haptic(name: HapticName): void {
  if (!enabled || !hapticsSupported()) return;
  try {
    navigator.vibrate(PATTERNS[name]);
  } catch {
    return;
  }
}
