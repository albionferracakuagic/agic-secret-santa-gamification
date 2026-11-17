import { ShortCodeSchema, SHORT_CODE_LENGTH } from '@santa/contracts';

/** Canonical short code (case/space/hyphen-insensitive, same rule as the server) or undefined if invalid. */
export const normalizeShortCode = (raw: string): string | undefined => {
  const r = ShortCodeSchema.safeParse(raw);
  return r.success ? r.data : undefined;
};

/** ABCDE-FGHJK: grouped for reading aloud and typing. */
export const formatShortCode = (code: string): string =>
  code.length === SHORT_CODE_LENGTH ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
