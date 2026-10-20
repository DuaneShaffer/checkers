import { describe, expect, it } from 'vitest';
import { formatRoomCode, generateRoomCode, isRoomCode, parseRoomCode } from '../../src/net/roomCode.ts';

describe('room codes', () => {
  it('generates 10 Crockford base32 characters', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
      expect(isRoomCode(code)).toBe(true);
    }
  });

  it('maps every 5-bit value to a distinct alphabet symbol', () => {
    const seen = new Set<string>();
    for (let start = 0; start < 32; start += 10) {
      for (const c of generateRoomCode((len) => Uint8Array.from({ length: len }, (_, i) => (start + i) % 32))) seen.add(c);
    }
    expect(seen.size).toBe(32);
    expect(generateRoomCode((len) => new Uint8Array(len).fill(0xff))).toBe('ZZZZZZZZZZ');
  });

  it('formats as XXXXX-XXXXX', () => {
    expect(formatRoomCode('ABCDE12345')).toBe('ABCDE-12345');
  });

  it('parses user input leniently', () => {
    expect(parseRoomCode('abcde-12345')).toBe('ABCDE12345');
    expect(parseRoomCode(' AbCdE 12345 ')).toBe('ABCDE12345');
    expect(parseRoomCode('OIL00-11111')).toBe('01100' + '11111');
  });

  it('rejects bad codes', () => {
    expect(parseRoomCode('ABCDE1234')).toBeNull();
    expect(parseRoomCode('ABCDE123456')).toBeNull();
    expect(parseRoomCode('ABCDE1234U')).toBeNull();
    expect(parseRoomCode('ABCDE1234!')).toBeNull();
    expect(isRoomCode('abcde12345')).toBe(false);
    expect(isRoomCode(42)).toBe(false);
  });
});
