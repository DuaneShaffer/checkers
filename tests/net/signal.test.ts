import { describe, expect, it } from 'vitest';
import type { SignalPayload } from '../../src/net/protocol.ts';
import {
  MAX_BLOB_LENGTH, SignalError, blobFromLinkOrCode, decodeSignal, encodeSignal, fromBase64Url, minimizeSdp, toBase64Url, validateSdp,
} from '../../src/net/signal.ts';
import * as samples from './sdpSamples.ts';

const SAMPLES = Object.entries(samples) as [string, string][];

async function deflate(text: string): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return toBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
}

describe('minimizeSdp', () => {
  it.each(SAMPLES)('keeps what a datachannel session needs (%s)', (_name, sdp) => {
    const min = minimizeSdp(sdp);
    expect(validateSdp(min)).toBe(true);
    const lines = min.trimEnd().split('\r\n');
    expect(lines[0]).toBe('v=0');
    for (const prefix of ['o=', 's=', 't=', 'm=application', 'c=', 'a=ice-ufrag:', 'a=ice-pwd:', 'a=fingerprint:sha-256 ', 'a=setup:', 'a=mid:0', 'a=sctp-port:5000']) {
      expect(lines.some((l) => l.startsWith(prefix)), prefix).toBe(true);
    }
    const original = sdp.split('\r\n');
    for (const key of ['a=ice-ufrag:', 'a=ice-pwd:', 'a=fingerprint:', 'a=setup:']) {
      expect(lines.find((l) => l.startsWith(key))).toBe(original.find((l) => l.startsWith(key)));
    }
    expect(min).not.toMatch(/extmap-allow-mixed|msid-semantic|ice-options|a=sendrecv|tcptype|generation|network-cost|network-id/);
  });

  it('keeps udp candidates with their address, port and type and drops tcp ones', () => {
    const min = minimizeSdp(samples.chromeOfferMdns);
    const cands = min.split('\r\n').filter((l) => l.startsWith('a=candidate:'));
    expect(cands).toEqual([
      'a=candidate:1 1 udp 2113937151 dd689016-3f61-4fce-93ff-739365d2307a.local 33548 typ host',
      'a=candidate:2 1 udp 1677729535 137.229.79.43 17731 typ srflx raddr 0.0.0.0 rport 0',
      'a=candidate:2 1 udp 1677729535 137.229.79.43 51038 typ srflx raddr 0.0.0.0 rport 0',
    ]);
  });

  it('keeps IPv6 reflexive candidates', () => {
    expect(minimizeSdp(samples.chromeOfferMobileDualStack)).toContain('2600:387:f:4e1a::5 49431 typ srflx');
  });

  it('keeps reflexive candidates when a device has many host candidates', async () => {
    const lines = samples.chromeOfferMdns.split('\r\n');
    const firstCandidate = lines.findIndex((l) => l.startsWith('a=candidate:'));
    const hosts = Array.from({ length: 10 }, (_, i) =>
      `a=candidate:${100 + i} 1 udp ${2122260223 - i} ${i < 5 ? `fd00::${i + 1}` : `10.0.${i}.2`} ${40000 + i} typ host generation 0 network-id ${i + 1} network-cost ${i === 9 ? 10 : 50}`);
    const srflx = 'a=candidate:999 1 udp 1686052607 203.0.113.7 61000 typ srflx raddr 10.0.5.2 rport 40005 generation 0 network-cost 50';
    const sdp = [...lines.slice(0, firstCandidate), ...hosts, srflx, ...lines.slice(firstCandidate)].join('\r\n');
    const min = minimizeSdp(sdp);
    expect(validateSdp(min)).toBe(true);
    const cands = min.split('\r\n').filter((l) => l.startsWith('a=candidate:'));
    expect(cands.length).toBe(8);
    expect(cands.filter((l) => l.includes(' typ srflx'))).toHaveLength(3);
    expect(min).toContain('203.0.113.7 61000 typ srflx');
    expect(min).toContain('10.0.9.2 40009 typ host');
    expect(min).toContain('10.0.5.2 40005 typ host');
    expect(min).not.toContain('fd00::');
    const decoded = await decodeSignal(await encodeSignal({ v: 1, code: 'ABCDE12345', role: 'guest', sdp }));
    expect(decoded.sdp).toContain('203.0.113.7 61000 typ srflx');
  });

  it('keeps session-level fingerprint (Firefox)', () => {
    expect(minimizeSdp(samples.firefoxOffer)).toContain('a=fingerprint:sha-256 6B:8B:F0');
    expect(minimizeSdp(samples.firefoxOffer)).toContain('a=end-of-candidates');
  });

  it('is idempotent', () => {
    for (const [, sdp] of SAMPLES) expect(minimizeSdp(minimizeSdp(sdp))).toBe(minimizeSdp(sdp));
  });
});

describe('encodeSignal / decodeSignal', () => {
  it.each(SAMPLES)('round-trips %s', async (_name, sdp) => {
    const payload: SignalPayload = { v: 1, code: 'K7Q2M9XA3T', role: 'host', sdp, name: 'Duane' };
    const blob = await encodeSignal(payload);
    expect(blob).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(blob.length).toBeLessThan(900);
    const decoded = await decodeSignal(blob);
    expect(decoded).toEqual({ ...payload, sdp: minimizeSdp(sdp) });
  });

  it('round-trips a guest resume payload with a game id', async () => {
    const payload: SignalPayload = { v: 1, code: 'ABCDE12345', role: 'guest', sdp: samples.chromeAnswerMdns, gameId: '3.k2j4h5' };
    const decoded = await decodeSignal(await encodeSignal(payload));
    expect(decoded.role).toBe('guest');
    expect(decoded.gameId).toBe('3.k2j4h5');
    expect(decoded.name).toBeUndefined();
  });

  it('keeps typical blobs well under 900 characters', async () => {
    const sizes = await Promise.all(SAMPLES.map(async ([, sdp]) => (await encodeSignal({ v: 1, code: 'ABCDE12345', role: 'host', sdp, name: 'A long display name!!' })).length));
    expect(Math.max(...sizes)).toBeLessThan(900);
    expect(sizes.reduce((a, b) => a + b, 0) / sizes.length).toBeLessThan(750);
  });

  it('sanitizes names', async () => {
    const decoded = await decodeSignal(await encodeSignal({ v: 1, code: 'ABCDE12345', role: 'host', sdp: samples.chromeOfferMdns, name: '  <b>Bob</b>\u0000‮   the   great and powerful wizard ' }));
    expect(decoded.name).toBe('<b>Bob</b> the great and');
    expect(decoded.name!.length).toBeLessThanOrEqual(24);
  });

  const rejects = async (blob: string) => {
    await expect(decodeSignal(blob)).rejects.toBeInstanceOf(SignalError);
  };

  it('rejects garbage, truncation and tampering', async () => {
    const blob = await encodeSignal({ v: 1, code: 'ABCDE12345', role: 'host', sdp: samples.chromeOfferMdns });
    await rejects('');
    await rejects('not a blob!');
    await rejects(blob.slice(0, blob.length - 20));
    await rejects(blob.slice(0, 40));
    await rejects('A'.repeat(MAX_BLOB_LENGTH + 1));
    await rejects(blob.slice(0, 10) + (blob[10] === 'A' ? 'B' : 'A') + blob.slice(11));
  });

  it('rejects well-formed payloads with bad fields', async () => {
    const sdp = minimizeSdp(samples.chromeOfferMdns);
    await rejects(await deflate(JSON.stringify([2, 'ABCDE12345', 'h', sdp, 0, 0])));
    await rejects(await deflate(JSON.stringify([1, 'abcde12345', 'h', sdp, 0, 0])));
    await rejects(await deflate(JSON.stringify([1, 'ABCDE12345', 'x', sdp, 0, 0])));
    await rejects(await deflate(JSON.stringify([1, 'ABCDE12345', 'h', 'v=0\r\n', 0, 0])));
    await rejects(await deflate(JSON.stringify([1, 'ABCDE12345', 'h', sdp + 'a=evil:\u0007\r\n', 0, 0])));
    await rejects(await deflate(JSON.stringify([1, 'ABCDE12345', 'h', sdp, 'bad id!', 0])));
    await rejects(await deflate(JSON.stringify([1, 'ABCDE12345', 'h', sdp, 0, 5])));
    await rejects(await deflate(JSON.stringify({ v: 1, code: 'ABCDE12345' })));
    await rejects(await deflate('not json'));
  });

  it('rejects decompression bombs', async () => {
    await rejects(await deflate(JSON.stringify([1, 'ABCDE12345', 'h', 'x'.repeat(200_000), 0, 0])));
  });

  it('rejects SDP that is not a single datachannel section', async () => {
    const sdp = minimizeSdp(samples.chromeOfferMdns);
    expect(validateSdp(sdp.replace('m=application 17731 UDP/DTLS/SCTP webrtc-datachannel', 'm=audio 9 UDP/TLS/RTP/SAVPF 111'))).toBe(false);
    expect(validateSdp(sdp + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n')).toBe(false);
    expect(validateSdp(sdp.replace(/a=ice-pwd:.*\r\n/, ''))).toBe(false);
    expect(validateSdp(sdp.replace(/\r\n$/, ''))).toBe(false);
  });
});

describe('helpers', () => {
  it('base64url round-trips arbitrary bytes', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    for (let n = 0; n < 10; n++) {
      const slice = bytes.slice(n * 7, n * 7 + n * 11 + 1);
      expect(fromBase64Url(toBase64Url(slice))).toEqual(slice);
    }
    expect(() => fromBase64Url('ab+c')).toThrow(SignalError);
  });

  it('extracts blobs from links or bare codes', () => {
    expect(blobFromLinkOrCode('https://duaneshaffer.github.io/checkers/#/answer/abc_DEF-123')).toBe('abc_DEF-123');
    expect(blobFromLinkOrCode('  http://127.0.0.1:5186/checkers/?test=1#/join/xyz  ')).toBe('xyz');
    expect(blobFromLinkOrCode('abc_DEF-123')).toBe('abc_DEF-123');
    expect(blobFromLinkOrCode('Here is my link: https://x/#/answer/QQ')).toBe('QQ');
    expect(blobFromLinkOrCode('hello world')).toBeNull();
  });
});
