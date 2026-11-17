/** Asset licensing policy (doc/assets-licensing.md). Shared by the manifest test and the /credits page. */
export const ALLOWED_LICENSES = [
  'CC0-1.0',
  'LicenseRef-PublicDomain',
  'MIT',
  'ISC',
  'Apache-2.0',
  'OFL-1.1',
] as const;
/** Allowed only when attributionRequired is true and attributionText is shown on /credits. */
export const ATTRIBUTION_LICENSES = ['CC-BY-4.0'] as const;
/** Never acceptable, whatever the manifest says (NC/ND/GPL/CC-BY-SA/unclear/AI-generated/carol recordings). */
export const FORBIDDEN_PATTERN = /(-NC|-ND|GPL|-SA\b|CC-BY-SA|unclear|unknown|ai-generated|carol)/i;

export interface ManifestAsset {
  id: string;
  type: string;
  file: string;
  source: string;
  author: string;
  license: string;
  licenseUrl: string;
  retrievedAt: string;
  licenseSnapshot: string;
  attributionRequired: boolean;
  attributionText: string | null;
  modified: boolean;
  sha256: string | null;
  approvedBy: string;
}

export const MANIFEST_FIELDS: ReadonlyArray<keyof ManifestAsset> = [
  'id',
  'type',
  'file',
  'source',
  'author',
  'license',
  'licenseUrl',
  'retrievedAt',
  'licenseSnapshot',
  'attributionRequired',
  'attributionText',
  'modified',
  'sha256',
  'approvedBy',
];

export function isAllowedLicense(
  a: Pick<ManifestAsset, 'license' | 'attributionRequired' | 'attributionText'>,
) {
  if (FORBIDDEN_PATTERN.test(a.license)) return false;
  if ((ALLOWED_LICENSES as readonly string[]).includes(a.license)) return true;
  return (
    (ATTRIBUTION_LICENSES as readonly string[]).includes(a.license) &&
    a.attributionRequired &&
    !!a.attributionText
  );
}
