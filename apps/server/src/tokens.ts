import { createHash, randomBytes, randomInt } from 'node:crypto';

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Unambiguous uppercase alphabet (no I/O/0/1): matches the contract regex [A-Z2-9]. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const randomCode = (len: number) =>
  Array.from({ length: len }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function parseCookies(header: string | undefined): Record<string, string> {
  const map = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || UNSAFE_KEYS.has(k) || map.has(k)) continue;
    const raw = part.slice(i + 1).trim();
    let v = raw;
    try {
      v = decodeURIComponent(raw);
    } catch {
      // malformed escape: keep the raw value
    }
    map.set(k, v);
  }
  return Object.assign(Object.create(null) as Record<string, string>, Object.fromEntries(map));
}
