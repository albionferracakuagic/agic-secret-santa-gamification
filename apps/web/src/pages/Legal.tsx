import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { LEGAL_DOCUMENTS } from '@santa/contracts';
import { Markdown, splitLegal } from '../components/Markdown';

/** doc/legal/*.md bundled at build time (static, no runtime fetch). */
const raw = import.meta.glob('../../../../doc/legal/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const docs = Object.fromEntries(
  Object.entries(raw).map(([path, src]) => [path.split('/').pop()!.replace(/\.md$/, ''), src]),
);

export default function Legal() {
  const { t, i18n } = useTranslation();
  const { doc = '' } = useParams();
  const known = (LEGAL_DOCUMENTS as readonly string[]).includes(doc) && docs[doc] !== undefined;
  const dev = import.meta.env.DEV;
  if (!known)
    return (
      <section className="space-y-3">
        <h1 className="text-2xl font-bold">{t('legal.notFound')}</h1>
        <Link to="/legal/privacy" className="underline">
          {t('legal.privacy')}
        </Link>
      </section>
    );
  const parts = splitLegal(docs[doc]!);
  const lang = i18n.language === 'it' ? 'it' : 'en';
  return (
    <article aria-labelledby="legal-title" className="space-y-4">
      <h1 id="legal-title" className="text-2xl font-bold">
        {t(`legal.${doc}`)}
      </h1>
      <nav aria-label={t('legal.nav')} className="flex gap-4">
        {LEGAL_DOCUMENTS.map((d) => (
          <Link
            key={d}
            to={`/legal/${d}`}
            className="underline"
            aria-current={d === doc ? 'page' : undefined}
          >
            {t(`legal.${d}`)}
          </Link>
        ))}
      </nav>
      {dev && parts.preamble && (
        <div data-testid="legal-draft-banner">
          <Markdown source={parts.preamble.replace(/^#.*$/m, '')} dev />
        </div>
      )}
      <Markdown source={parts[lang]} dev={dev} />
    </article>
  );
}
