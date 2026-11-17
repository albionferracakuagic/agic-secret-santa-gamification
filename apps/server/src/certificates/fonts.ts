import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decompress } from 'wawoff2';

/**
 * The certificate fonts are the web app's self-hosted, licensed fonts (Nunito OFL-1.1, Mountains of Christmas
 * Apache-2.0; see apps/web/src/fx/assets.manifest.json). They ship as WOFF2, which satori cannot read, so they are
 * unpacked to TTF in memory once. Nothing is written to disk and no other font is used.
 */
export interface CertFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 700;
  style: 'normal';
}

const FILES: Array<{ name: string; file: string; weight: 400 | 700 }> = [
  { name: 'Nunito', file: 'nunito-latin-400.woff2', weight: 400 },
  { name: 'Nunito', file: 'nunito-latin-700.woff2', weight: 700 },
  { name: 'Mountains of Christmas', file: 'mountains-of-christmas-latin-400.woff2', weight: 400 },
  { name: 'Mountains of Christmas', file: 'mountains-of-christmas-latin-700.woff2', weight: 700 },
];

export function fontDirCandidates(extra?: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    ...(extra ? [extra] : []),
    ...(process.env['CERT_FONTS_DIR'] ? [process.env['CERT_FONTS_DIR']] : []),
    ...(process.env['WEB_DIST'] ? [join(process.env['WEB_DIST'], 'assets', 'fonts')] : []),
    resolve(here, '../../../web/public/assets/fonts'),
    resolve(here, '../../../web/dist/assets/fonts'),
    resolve(process.cwd(), 'apps/web/public/assets/fonts'),
    resolve(process.cwd(), 'apps/web/dist/assets/fonts'),
  ];
}

let cache: Promise<CertFont[]> | undefined;

export function loadCertFonts(dir?: string): Promise<CertFont[]> {
  cache ??= (async () => {
    const base = fontDirCandidates(dir).find((d) => existsSync(join(d, FILES[0]!.file)));
    if (!base) throw new Error('certificate fonts not found (set CERT_FONTS_DIR)');
    return Promise.all(
      FILES.map(async (f) => {
        const ttf = await decompress(new Uint8Array(await readFile(join(base, f.file))));
        const data = ttf.buffer.slice(
          ttf.byteOffset,
          ttf.byteOffset + ttf.byteLength,
        ) as ArrayBuffer;
        return { name: f.name, data, weight: f.weight, style: 'normal' as const };
      }),
    );
  })();
  cache.catch(() => (cache = undefined));
  return cache;
}
