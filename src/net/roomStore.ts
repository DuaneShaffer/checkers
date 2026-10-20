import type { Side } from '../engine/types.ts';
import type { OnlineGame, PendingOffer, Role } from './protocol.ts';
import { isRoomCode } from './roomCode.ts';
import { isOnlineGame, isPendingOffer } from './wire.ts';

export const ROOM_PREFIX = 'checkers:room:';
export const CLIENT_ID_KEY = 'checkers:clientId';
const ROOM_TTL_MS = 30 * 24 * 3600 * 1000;
const UNSTARTED_TTL_MS = 24 * 3600 * 1000;

export interface RoomRecord {
  v: 1;
  code: string;
  role: Role;
  clientId: string;
  name?: string;
  peerClientId?: string;
  peerName?: string;
  firstHostSide: Side;
  game: OnlineGame | null;
  offer?: PendingOffer;
  createdAt: number;
  updatedAt: number;
}

const memory = new Map<string, string>();
let persistent = true;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    const value = storage()?.getItem(key);
    if (value != null) return value;
  } catch {
    persistent = false;
  }
  return memory.get(key) ?? null;
}

function write(key: string, value: string): boolean {
  memory.set(key, value);
  try {
    const s = storage();
    if (!s) throw new Error('no storage');
    s.setItem(key, value);
    return true;
  } catch {
    persistent = false;
    return false;
  }
}

function remove(key: string): void {
  memory.delete(key);
  try {
    storage()?.removeItem(key);
  } catch {
    persistent = false;
  }
}

export function isStoragePersistent(): boolean {
  return persistent && storage() !== null;
}

function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function getClientId(): string {
  const existing = read(CLIENT_ID_KEY);
  if (existing && /^[A-Za-z0-9-]{8,40}$/.test(existing)) return existing;
  const id = randomId();
  write(CLIENT_ID_KEY, id);
  return id;
}

function isRecord(v: unknown, code: string): v is RoomRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r.v === 1 &&
    r.code === code &&
    (r.role === 'host' || r.role === 'guest') &&
    typeof r.clientId === 'string' &&
    (r.firstHostSide === 0 || r.firstHostSide === 1) &&
    (r.game === null || isOnlineGame(r.game)) &&
    (r.offer === undefined || isPendingOffer(r.offer)) &&
    typeof r.updatedAt === 'number'
  );
}

export function loadRoom(code: string): RoomRecord | null {
  if (!isRoomCode(code)) return null;
  const raw = read(ROOM_PREFIX + code);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed, code) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveRoom(record: RoomRecord): boolean {
  return write(ROOM_PREFIX + record.code, JSON.stringify({ ...record, updatedAt: Date.now() }));
}

export function deleteRoom(code: string): void {
  remove(ROOM_PREFIX + code);
}

function storedRoomCodes(): string[] {
  const codes = new Set<string>();
  try {
    const s = storage();
    for (let i = 0; s && i < s.length; i++) {
      const key = s.key(i);
      if (key?.startsWith(ROOM_PREFIX)) codes.add(key.slice(ROOM_PREFIX.length));
    }
  } catch {
    persistent = false;
  }
  for (const key of memory.keys()) if (key.startsWith(ROOM_PREFIX)) codes.add(key.slice(ROOM_PREFIX.length));
  return [...codes];
}

export function listRooms(): RoomRecord[] {
  return storedRoomCodes()
    .map(loadRoom)
    .filter((r): r is RoomRecord => r !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function pruneRooms(now = Date.now()): void {
  for (const code of storedRoomCodes()) {
    const room = loadRoom(code);
    const ttl = room?.game ? ROOM_TTL_MS : UNSTARTED_TTL_MS;
    if (!room || now - room.updatedAt > ttl) deleteRoom(code);
  }
}
