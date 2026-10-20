const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ROOM_CODE_LENGTH = 10;
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{10}$/;

export function generateRoomCode(randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  let code = '';
  for (const byte of bytes) code += ALPHABET[byte & 31];
  return code;
}

export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_RE.test(value);
}

export function parseRoomCode(input: string): string | null {
  const code = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  return isRoomCode(code) ? code : null;
}

export function formatRoomCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}
