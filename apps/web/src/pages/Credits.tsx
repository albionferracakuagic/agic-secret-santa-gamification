import { useTranslation } from 'react-i18next';
import manifest from '../fx/assets.manifest.json';
import type { ManifestAsset } from '../fx/assetPolicy';

/** License texts bundled at build time, so this page works offline (service worker precaches the chunk). */
const texts = import.meta.glob('../../licenses/*.txt', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const textOf = (snapshot: string) => texts[`../../${snapshot}`] ?? '';

const assets = manifest.assets as ManifestAsset[];
const NOTICE_LICENSES = ['OFL-1.1', 'Apache-2.0'];

/** /credits — attribution entries plus the OFL/Apache notices and the Lottie note. */
export default function Credits() {
  const { t } = useTranslation();
  const credited = assets.filter((a) => a.attributionRequired);
  const lottie = assets.filter((a) => a.type === 'lottie');
  const notices = [
    ...new Map(
      assets.filter((a) => NOTICE_LICENSES.includes(a.license)).map((a) => [a.licenseSnapshot, a]),
    ).values(),
  ];
  const libs = assets.filter((a) => a.type === 'library');
  return (
    <section aria-labelledby="credits-title" className="space-y-5">
      <h1 id="credits-title" className="text-2xl font-bold">
        {t('credits.title')}
      </h1>
      <p>{t('credits.intro')}</p>

      <section aria-labelledby="credits-attr" className="space-y-2">
        <h2 id="credits-attr" className="text-xl font-semibold">
          {t('credits.attribution')}
        </h2>
        <ul className="list-disc space-y-1 pl-5" data-testid="credits-list">
          {credited.map((a) => (
            <li key={a.id}>
              {a.attributionText}{' '}
              <a className="underline" href={a.licenseUrl} rel="noreferrer">
                {a.license}
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="credits-notices" className="space-y-2">
        <h2 id="credits-notices" className="text-xl font-semibold">
          {t('credits.notices')}
        </h2>
        {notices.map((a) => (
          <details key={a.licenseSnapshot} className="rounded border border-ink-900/20 p-2">
            <summary className="min-h-11 cursor-pointer font-semibold">
              {a.license}: {a.author}
            </summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-xs">
              {textOf(a.licenseSnapshot)}
            </pre>
          </details>
        ))}
        <p data-testid="lottie-notice">
          {lottie.length === 0
            ? t('credits.noLottie')
            : lottie.map((a) => a.attributionText).join(' ')}
        </p>
      </section>

      <section aria-labelledby="credits-libs" className="space-y-2">
        <h2 id="credits-libs" className="text-xl font-semibold">
          {t('credits.libraries')}
        </h2>
        <ul className="list-disc pl-5">
          {libs.map((a) => (
            <li key={a.id}>
              {a.source} — {a.license}
            </li>
          ))}
        </ul>
        <p>{t('credits.own')}</p>
      </section>
    </section>
  );
}
