export const ZIP_LIMITS = {
  maxEntries: 200,
  maxTotalUncompressed: 50 * 1024 * 1024,
  /** Ratio check only applies to entries above this size (tiny XML parts compress extremely well legitimately). */
  ratioFloorBytes: 1024 * 1024,
  maxRatio: 200,
} as const;

/**
 * Zip-bomb guard for XLSX uploads (the 2 MB cap applies to the compressed file). Reads ONLY the central
 * directory (declared sizes), never inflates anything. Returns false for malformed or oversized archives.
 */
export function isSafeZip(buf: Buffer): boolean {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return false;
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let p = buf.readUInt32LE(eocd + 16);
  if (entries > ZIP_LIMITS.maxEntries || p + cdSize > buf.length) return false;

  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return false;
    const compressed = buf.readUInt32LE(p + 20);
    const uncompressed = buf.readUInt32LE(p + 24);
    // 0xFFFFFFFF = zip64 marker: sizes unknown without inflating, refuse
    if (uncompressed === 0xffffffff || compressed === 0xffffffff) return false;
    total += uncompressed;
    if (total > ZIP_LIMITS.maxTotalUncompressed) return false;
    if (
      uncompressed > ZIP_LIMITS.ratioFloorBytes &&
      uncompressed / Math.max(1, compressed) > ZIP_LIMITS.maxRatio
    )
      return false;
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return true;
}
