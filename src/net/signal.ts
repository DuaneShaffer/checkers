import type { Role, SignalPayload } from './protocol.ts';
import { isRoomCode } from './roomCode.ts';
import { cleanName, isGameId } from './wire.ts';

export const MAX_BLOB_LENGTH = 3000;
const MAX_JSON_BYTES = 8 * 1024;
const MAX_SDP_LENGTH = 3000;
const MAX_SDP_LINES = 40;
const MAX_CANDIDATES = 8;
const MAX_REFLEXIVE_CANDIDATES = 4;
const BLOB_RE = /^[A-Za-z0-9_-]+$/;
const SDP_LINE_RE = /^[a-z]=[\x20-\x7e]*$/;

export class SignalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalError';
  }
}

const KEPT_ATTRIBUTES = new Set([
  'group', 'ice-ufrag', 'ice-pwd', 'ice-lite', 'fingerprint', 'setup', 'mid',
  'sctp-port', 'sctpmap', 'max-message-size', 'candidate', 'end-of-candidates',
]);
const KEPT_LINE_TYPES = new Set(['v', 'o', 's', 't', 'm', 'c']);

interface Candidate { foundation: string; rest: string; key: string; type: string; priority: number; cost: number; ipv6: boolean; index: number }

function parseCandidate(value: string, index: number): Candidate | null {
  const tok = value.split(' ');
  if (tok.length < 8 || tok[1] !== '1' || tok[2].toLowerCase() !== 'udp' || tok[6] !== 'typ') return null;
  const [, , , priority, address, port, , type] = tok;
  if (!/^\d+$/.test(priority) || !/^\d+$/.test(port) || /^fe80:/i.test(address)) return null;
  const kept = ['1', 'udp', priority, address, port, 'typ', type];
  const raddr = tok.indexOf('raddr', 8);
  const rport = tok.indexOf('rport', 8);
  if (raddr > 0 && rport > 0 && tok[raddr + 1] && tok[rport + 1]) kept.push('raddr', tok[raddr + 1], 'rport', tok[rport + 1]);
  const costAt = tok.indexOf('network-cost', 8);
  const cost = costAt > 0 ? Number(tok[costAt + 1]) : 0;
  return {
    foundation: tok[0],
    rest: kept.join(' '),
    key: `${address} ${port} ${type}`,
    type,
    priority: Number(priority),
    cost: Number.isFinite(cost) ? cost : 0,
    ipv6: address.includes(':'),
    index,
  };
}

function byHostPreference(a: Candidate, b: Candidate): number {
  return a.cost - b.cost || Number(a.ipv6) - Number(b.ipv6) || b.priority - a.priority || a.index - b.index;
}

function selectCandidates(all: Candidate[]): Candidate[] {
  const unique = new Map<string, Candidate>();
  for (const c of all) if (!unique.has(c.key)) unique.set(c.key, c);
  const reachable = [...unique.values()].filter((c) => c.type !== 'host').slice(0, MAX_REFLEXIVE_CANDIDATES);
  const hosts = [...unique.values()].filter((c) => c.type === 'host').sort(byHostPreference).slice(0, MAX_CANDIDATES - reachable.length);
  return [...reachable, ...hosts].sort((a, b) => a.index - b.index);
}

export function minimizeSdp(sdp: string): string {
  const out: string[] = [];
  const parsed: Candidate[] = [];
  let candidateSlot = -1;
  for (const line of sdp.split(/\r?\n/)) {
    if (!line) continue;
    const type = line[0];
    if (KEPT_LINE_TYPES.has(type)) {
      out.push(line);
      continue;
    }
    if (type !== 'a') continue;
    const colon = line.indexOf(':');
    const name = line.slice(2, colon < 0 ? undefined : colon);
    if (!KEPT_ATTRIBUTES.has(name)) continue;
    if (name !== 'candidate') {
      out.push(line);
      continue;
    }
    if (candidateSlot < 0) candidateSlot = out.length;
    const cand = parseCandidate(line.slice(colon + 1), parsed.length);
    if (cand) parsed.push(cand);
  }
  const foundations = new Map<string, string>();
  const candidateLines = selectCandidates(parsed).map((c) => {
    if (!foundations.has(c.foundation)) foundations.set(c.foundation, String(foundations.size + 1));
    return `a=candidate:${foundations.get(c.foundation)} ${c.rest}`;
  });
  if (candidateSlot >= 0) out.splice(candidateSlot, 0, ...candidateLines);
  return out.join('\r\n') + '\r\n';
}

export function validateSdp(sdp: string): boolean {
  if (sdp.length > MAX_SDP_LENGTH) return false;
  const lines = sdp.split('\r\n');
  if (lines.pop() !== '' || lines.length > MAX_SDP_LINES || lines[0] !== 'v=0') return false;
  if (!lines.every((l) => SDP_LINE_RE.test(l))) return false;
  const count = (prefix: string) => lines.filter((l) => l.startsWith(prefix)).length;
  return (
    count('m=') === 1 &&
    lines.some((l) => /^m=application \d+ (UDP\/)?DTLS\/SCTP /.test(l)) &&
    count('a=ice-ufrag:') === 1 &&
    count('a=ice-pwd:') === 1 &&
    count('a=fingerprint:') >= 1 &&
    count('a=setup:') === 1
  );
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  if (!BLOB_RE.test(text) || text.length % 4 === 1) throw new SignalError('Invalid characters in link');
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function readLimited(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new SignalError('Link payload too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const written = writer.write(bytes as Uint8Array<ArrayBuffer>).then(() => writer.close());
  written.catch(() => {});
  const [out] = await Promise.all([readLimited(stream.readable, limit), written]);
  return out;
}

type Packed = [1, string, 'h' | 'g', string, string | 0, string | 0];

export async function encodeSignal(payload: SignalPayload): Promise<string> {
  const packed: Packed = [1, payload.code, payload.role === 'host' ? 'h' : 'g', minimizeSdp(payload.sdp), payload.gameId ?? 0, cleanName(payload.name) ?? 0];
  const json = new TextEncoder().encode(JSON.stringify(packed));
  return toBase64Url(await transform(json, new CompressionStream('deflate-raw'), MAX_JSON_BYTES));
}

function unpack(value: unknown): SignalPayload {
  if (!Array.isArray(value) || value.length !== 6 || value[0] !== 1) throw new SignalError('Unsupported link format');
  const [, code, roleChar, sdp, gameId, name] = value as unknown[];
  if (!isRoomCode(code)) throw new SignalError('Bad room code');
  if (roleChar !== 'h' && roleChar !== 'g') throw new SignalError('Bad role');
  if (typeof sdp !== 'string' || !validateSdp(sdp)) throw new SignalError('Bad connection data');
  if (gameId !== 0 && !isGameId(gameId)) throw new SignalError('Bad game id');
  if (name !== 0 && typeof name !== 'string') throw new SignalError('Bad name');
  const role: Role = roleChar === 'h' ? 'host' : 'guest';
  const payload: SignalPayload = { v: 1, code, role, sdp };
  if (gameId !== 0) payload.gameId = gameId;
  const clean = cleanName(name);
  if (clean) payload.name = clean;
  return payload;
}

export async function decodeSignal(blob: string): Promise<SignalPayload> {
  const text = blob.trim();
  if (!text || text.length > MAX_BLOB_LENGTH) throw new SignalError('Link has the wrong length');
  let json: Uint8Array;
  try {
    json = await transform(fromBase64Url(text), new DecompressionStream('deflate-raw'), MAX_JSON_BYTES);
  } catch (e) {
    throw e instanceof SignalError ? e : new SignalError('Link is damaged or incomplete');
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
  } catch {
    throw new SignalError('Link is damaged or incomplete');
  }
  return unpack(value);
}

export function blobFromLinkOrCode(input: string): string | null {
  const text = input.trim();
  const match = /#\/(?:join|answer)\/([A-Za-z0-9_-]+)/.exec(text);
  if (match) return match[1];
  return BLOB_RE.test(text) ? text : null;
}
