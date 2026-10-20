import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_ID_KEY, ROOM_PREFIX, deleteRoom, getClientId, listRooms, loadRoom, pruneRooms, saveRoom } from '../../src/net/roomStore.ts';
import type { RoomRecord } from '../../src/net/roomStore.ts';

class MemStorage {
  data = new Map<string, string>();
  fail = false;
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { if (this.fail) throw new Error('QuotaExceeded'); this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
  clear() { this.data.clear(); }
}

const room = (code: string, extra: Partial<RoomRecord> = {}): RoomRecord => ({
  v: 1, code, role: 'host', clientId: 'me', firstHostSide: 0, game: null, createdAt: 1, updatedAt: 1, ...extra,
});

let store: MemStorage;
beforeEach(() => {
  store = new MemStorage();
  (globalThis as { localStorage?: unknown }).localStorage = store;
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('roomStore', () => {
  it('keeps a stable client id', () => {
    const id = getClientId();
    expect(id).toMatch(/^[A-Za-z0-9-]{8,40}$/);
    expect(getClientId()).toBe(id);
    expect(store.getItem(CLIENT_ID_KEY)).toBe(id);
  });

  it('saves, loads, lists and deletes rooms', () => {
    const game = { id: '0.a', hostSide: 1 as const, moves: ['11-15'] };
    expect(saveRoom(room('ABCDE12345', { game }))).toBe(true);
    saveRoom(room('ZZZZZ00000'));
    expect(loadRoom('ABCDE12345')!.game).toEqual(game);
    expect(listRooms().map((r) => r.code).sort()).toEqual(['ABCDE12345', 'ZZZZZ00000']);
    deleteRoom('ABCDE12345');
    expect(loadRoom('ABCDE12345')).toBeNull();
  });

  it('ignores corrupt or foreign records', () => {
    store.setItem(ROOM_PREFIX + 'ABCDE12345', '{not json');
    expect(loadRoom('ABCDE12345')).toBeNull();
    store.setItem(ROOM_PREFIX + 'ABCDE12345', JSON.stringify(room('OTHER00000')));
    expect(loadRoom('ABCDE12345')).toBeNull();
    store.setItem(ROOM_PREFIX + 'ABCDE12345', JSON.stringify(room('ABCDE12345', { game: { id: '0.a', hostSide: 0, moves: ['<x>'] } as never })));
    expect(loadRoom('ABCDE12345')).toBeNull();
    expect(loadRoom('bad')).toBeNull();
  });

  it('falls back to memory when storage throws', () => {
    store.fail = true;
    expect(saveRoom(room('ABCDE12345'))).toBe(false);
    expect(loadRoom('ABCDE12345')).not.toBeNull();
  });

  it('prunes stale rooms', () => {
    saveRoom(room('ABCDE12345'));
    saveRoom(room('ZZZZZ00000', { game: { id: '0.a', hostSide: 0, moves: [] } }));
    const now = Date.now();
    pruneRooms(now + 2 * 24 * 3600 * 1000);
    expect(loadRoom('ABCDE12345')).toBeNull();
    expect(loadRoom('ZZZZZ00000')).not.toBeNull();
    pruneRooms(now + 40 * 24 * 3600 * 1000);
    expect(loadRoom('ZZZZZ00000')).toBeNull();
  });
});
