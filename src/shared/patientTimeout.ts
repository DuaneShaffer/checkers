const TICK_MS = 250;

/**
 * Like setTimeout, but a long main-thread stall (e.g. building the 3D scene on a slow phone)
 * only counts as two ticks, so work that was merely queued behind the stall isn't timed out.
 */
export function patientTimeout(ms: number, onTimeout: () => void): () => void {
  let remaining = ms;
  let last = Date.now();
  let id: ReturnType<typeof setTimeout>;
  const tick = () => {
    const now = Date.now();
    remaining -= Math.min(now - last, TICK_MS * 2);
    last = now;
    if (remaining <= 0) onTimeout();
    else id = setTimeout(tick, TICK_MS);
  };
  id = setTimeout(tick, Math.min(TICK_MS, ms));
  return () => clearTimeout(id);
}
