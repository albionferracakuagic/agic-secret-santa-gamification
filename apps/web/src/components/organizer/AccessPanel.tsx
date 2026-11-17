import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { useOrganizerApi, type AccessLink } from '../../api/organizer';
import { formatShortCode } from '../../lib/shortCode';
import { Qr } from '../Qr';
import { errorKey } from '../../pages/Dashboard';

const btn = 'min-h-12 rounded border border-ink-900 px-4 font-semibold disabled:opacity-50';

/** Invitations: a join link + short code + QR, and a display link. Tokens are shown once (only their hash is stored). */
export function AccessPanel({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const api = useOrganizerApi();
  const [links, setLinks] = useState<Partial<Record<'join' | 'display', AccessLink>>>({});
  const create = useMutation({
    mutationFn: (kind: 'join' | 'display') => api.createAccess(eventId, kind),
    onSuccess: (l) => setLinks((s) => ({ ...s, [l.kind]: l })),
  });
  const url = (l: AccessLink) => new URL(l.path, location.origin).toString();
  return (
    <section aria-labelledby="access-title" className="space-y-3">
      <h2 id="access-title" className="text-xl font-semibold">
        {t('access.title')}
      </h2>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={btn}
          disabled={create.isPending}
          onClick={() => create.mutate('join')}
        >
          {t('access.createJoin')}
        </button>
        <button
          type="button"
          className={btn}
          disabled={create.isPending}
          onClick={() => create.mutate('display')}
        >
          {t('access.createDisplay')}
        </button>
      </div>
      {links.join && (
        <div className="space-y-2" data-testid="join-link">
          <p className="text-sm">{t('access.once')}</p>
          <p>
            {t('access.link')}: <code>{url(links.join)}</code>
          </p>
          {links.join.shortCode && (
            <p>
              {t('access.code')}:{' '}
              <strong className="tracking-widest">{formatShortCode(links.join.shortCode)}</strong>
            </p>
          )}
          <div className="h-48 w-48 rounded bg-white p-2">
            <Qr value={url(links.join)} label={t('display.qrLabel')} />
          </div>
          <p className="text-sm">{t('access.expires', { at: links.join.expiresAt })}</p>
        </div>
      )}
      {links.display && (
        <div className="space-y-1" data-testid="display-link">
          <p className="text-sm">{t('access.once')}</p>
          <p>
            {t('access.displayLink')}: <code>{url(links.display)}</code>
          </p>
        </div>
      )}
      {create.isError && (
        <p role="alert" className="rounded bg-santa-700 p-3 text-white">
          {t(errorKey(create.error))}
        </p>
      )}
    </section>
  );
}
