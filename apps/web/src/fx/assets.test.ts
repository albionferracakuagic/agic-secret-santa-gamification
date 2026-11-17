import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import manifest from './assets.manifest.json';
import {
  FORBIDDEN_PATTERN,
  MANIFEST_FIELDS,
  isAllowedLicense,
  type ManifestAsset,
} from './assetPolicy';

const WEB = resolve(process.cwd(), 'apps/web');
const assets = manifest.assets as ManifestAsset[];

const TEXT_EXT = /\.(svg|json|txt|md|css|html|xml)$/i;
// Text files are hashed after CRLF->LF so the result does not depend on git autocrlf.
const assetSha256 = (path: string): string => {
  const buf = readFileSync(path);
  const data = TEXT_EXT.test(path)
    ? Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
    : buf;
  return createHash('sha256').update(data).digest('hex');
};

const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
      })
    : [];

describe('asset licensing register (doc/assets-licensing.md)', () => {
  it('every entry has all required fields and unique ids', () => {
    expect(assets.length).toBeGreaterThan(0);
    for (const a of assets)
      for (const f of MANIFEST_FIELDS) expect(a, `${a.id}.${f}`).toHaveProperty(f);
    expect(new Set(assets.map((a) => a.id)).size).toBe(assets.length);
  });

  it('every license is allowed by the policy; CC-BY needs attribution text; forbidden licenses never pass', () => {
    for (const a of assets) {
      expect(isAllowedLicense(a), `${a.id}: ${a.license}`).toBe(true);
      expect(a.approvedBy, a.id).toBeTruthy();
      expect(a.author, a.id).toBeTruthy();
      if (a.attributionRequired) expect(a.attributionText, a.id).toBeTruthy();
    }
    for (const bad of [
      'CC-BY-NC-4.0',
      'CC-BY-ND-4.0',
      'GPL-3.0-only',
      'CC-BY-SA-4.0',
      'unclear',
      'AI-generated',
    ])
      expect(
        isAllowedLicense({ license: bad, attributionRequired: true, attributionText: 'x' }),
        bad,
      ).toBe(false);
    expect(
      isAllowedLicense({ license: 'CC-BY-4.0', attributionRequired: false, attributionText: null }),
    ).toBe(false);
    expect(FORBIDDEN_PATTERN.test('carol-recording')).toBe(true);
  });

  it('every file under apps/web/public (assets, fonts, icons) is in the manifest, with a matching sha256', () => {
    const files = walk(join(WEB, 'public')).map((p) => relative(WEB, p).replaceAll('\\', '/'));
    expect(files.length).toBeGreaterThan(0);
    const byFile = new Map(assets.map((a) => [a.file, a]));
    for (const f of files) {
      const a = byFile.get(f);
      expect(a, `${f} is not listed in assets.manifest.json`).toBeTruthy();
      expect(a!.sha256, `${f} needs a sha256`).toMatch(/^[0-9a-f]{64}$/);
      expect(assetSha256(join(WEB, f)), f).toBe(a!.sha256);
    }
  });

  it('manifest files exist and every license snapshot is shipped in licenses/', () => {
    for (const a of assets) {
      expect(existsSync(join(WEB, a.file)), `${a.id}: ${a.file}`).toBe(true);
      expect(a.licenseSnapshot.startsWith('licenses/'), a.id).toBe(true);
      expect(existsSync(join(WEB, a.licenseSnapshot)), `${a.id}: ${a.licenseSnapshot}`).toBe(true);
    }
  });

  it('fonts referenced by the stylesheet are self-hosted, registered, and no third-party font host is used', () => {
    const css = readFileSync(join(WEB, 'src/index.css'), 'utf8');
    const refs = [...css.matchAll(/url\(['"]?([^)'"]+\.woff2)['"]?\)/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThanOrEqual(4);
    for (const r of refs) {
      expect(r.startsWith('/assets/fonts/'), r).toBe(true);
      expect(
        assets.some((a) => a.file === `public${r}`),
        r,
      ).toBe(true);
    }
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic|https?:\/\//);
    expect(readFileSync(join(WEB, 'index.html'), 'utf8')).not.toMatch(
      /fonts\.googleapis|fonts\.gstatic/,
    );
  });

  it('the policy document exists and names the allowed and forbidden licenses', () => {
    const doc = readFileSync(resolve(WEB, '../../doc/assets-licensing.md'), 'utf8');
    for (const l of ['CC0', 'OFL', 'Apache', 'MIT', 'ISC', 'CC-BY', 'NC', 'GPL', 'AI-generated'])
      expect(doc).toContain(l);
    for (const f of MANIFEST_FIELDS) expect(doc).toContain(f);
  });
});
