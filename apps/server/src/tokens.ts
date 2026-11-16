import { createHash, randomBytes, randomInt } from 'node:crypto';

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Unambiguous uppercase alphabet (no I/O/0/1): matches the contract regex [A-Z2-9]. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const randomCode = (len: number) =>
  Array.from({ length: len }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
