import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patientTimeout } from '../../src/shared/patientTimeout.ts';

describe('patientTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires after the requested time when the thread is responsive', () => {
    const fired = vi.fn();
    patientTimeout(1000, fired);
    vi.advanceTimersByTime(999);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledOnce();
  });

  it('counts a long stall as only a short slice', () => {
    const fired = vi.fn();
    patientTimeout(1000, fired);
    vi.setSystemTime(Date.now() + 8000);
    vi.advanceTimersByTime(250);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(fired).toHaveBeenCalledOnce();
  });

  it('can be cancelled', () => {
    const fired = vi.fn();
    const cancel = patientTimeout(500, fired);
    vi.advanceTimersByTime(250);
    cancel();
    vi.advanceTimersByTime(5000);
    expect(fired).not.toHaveBeenCalled();
  });
});
