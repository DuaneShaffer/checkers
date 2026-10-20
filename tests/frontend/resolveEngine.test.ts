import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiClientApi } from '../../src/ai/protocol.ts';
import { MANIFEST_TIMEOUT_MS, resolveEngine } from '../../src/game/screens.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('resolveEngine', () => {
  it('falls back to the heuristic when the manifest fetch never settles', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadNet = vi.fn();
    const client = { loadNet } as unknown as AiClientApi;
    const pending = resolveEngine(client, null, () => {});
    await vi.advanceTimersByTimeAsync(MANIFEST_TIMEOUT_MS + 10);
    const resolved = await pending;
    expect(resolved.engine.netId).toBe('heuristic');
    expect(loadNet).not.toHaveBeenCalled();
  });
});
