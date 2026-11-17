import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { usePhase2Api, type MyCertificates } from '../../api/phase2';
import { useLocalized } from '../../lib/localized';

type Cert = MyCertificates['certificates'][number];

/** FR-041: own certificates only. Share uses the Web Share API with files when available, otherwise downloads the PNG. */
export function Certificates() {
  const { t, i18n } = useTranslation();
  const api = usePhase2Api();
  const loc = useLocalized();
  const q = useQuery({ queryKey: ['my-certificates'], queryFn: () => api.myCertificates() });
  const [msg, setMsg] = useState('');
  const locale = i18n.language === 'it' ? 'it' : 'en';
  const list = q.data?.certificates ?? [];

  const fetchFile = async (c: Cert) => {
    const blob = await api.fetchCertificate(c.url, locale);
    return new File([blob], `${c.key}-${locale}.png`, { type: 'image/png' });
  };
  const download = async (c: Cert) => {
    setMsg('');
    try {
      const file = await fetchFile(c);
      const href = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = href;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(href);
      setMsg(t('cert.shared'));
    } catch {
      setMsg(t('cert.failed'));
    }
  };
  const share = async (c: Cert) => {
    setMsg('');
    try {
      const file = await fetchFile(c);
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: loc(c.title) });
        setMsg(t('cert.shared'));
      } else await download(c);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) setMsg(t('cert.failed'));
    }
  };

  const btn = 'min-h-12 rounded border border-ink-900 px-4 font-semibold';
  return (
    <section aria-labelledby="cert-title" className="space-y-2" data-testid="certificates">
      <h2 id="cert-title" className="font-semibold">
        {t('cert.title')}
      </h2>
      {list.length === 0 ? (
        <p>{t('cert.none')}</p>
      ) : (
        <ul className="space-y-2">
          {list.map((c) => (
            <li key={c.key} className="flex flex-wrap items-center gap-2">
              <span className="grow">📜 {loc(c.title)}</span>
              <button
                type="button"
                className={btn}
                aria-label={t('cert.download', { title: loc(c.title) })}
                onClick={() => void download(c)}
              >
                ⬇ PNG
              </button>
              {typeof navigator.share === 'function' && (
                <button
                  type="button"
                  className={btn}
                  aria-label={t('cert.share', { title: loc(c.title) })}
                  onClick={() => void share(c)}
                >
                  ↗
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p role="status">{msg}</p>
    </section>
  );
}
