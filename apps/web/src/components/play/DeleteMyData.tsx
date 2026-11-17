import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { usePlayApi, type DeleteMeResponse } from '../../api/play';
import { errorKey } from '../../pages/Dashboard';

/** "Delete my data": two-step confirmation, then a summary of what was erased. Irreversible. */
export function DeleteMyData() {
  const { t } = useTranslation();
  const api = usePlayApi();
  const nav = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<DeleteMeResponse>();
  const del = useMutation({ mutationFn: () => api.deleteMe(), onSuccess: setDone });

  if (done)
    return (
      <section aria-labelledby="privacy-title" className="space-y-2">
        <h2 id="privacy-title" className="font-semibold">
          {t('privacy.title')}
        </h2>
        <p role="status">{t('privacy.done')}</p>
        <ul className="list-disc pl-5" data-testid="erased">
          {done.erased.map((e) => (
            <li key={e}>{t(`privacy.erased.${e}`)}</li>
          ))}
        </ul>
        <button
          type="button"
          className="min-h-12 rounded border border-ink-900 px-4"
          onClick={() => nav('/j')}
        >
          {t('privacy.leave')}
        </button>
      </section>
    );

  return (
    <section aria-labelledby="privacy-title" className="space-y-2">
      <h2 id="privacy-title" className="font-semibold">
        {t('privacy.title')}
      </h2>
      <p>{t('privacy.explain')}</p>
      {!confirming ? (
        <button
          type="button"
          className="min-h-12 rounded border border-santa-600 px-4 text-santa-700"
          onClick={() => setConfirming(true)}
        >
          {t('privacy.delete')}
        </button>
      ) : (
        <div
          role="group"
          aria-label={t('privacy.confirmTitle')}
          className="space-y-2 rounded border-2 border-santa-600 p-3"
        >
          <p className="font-semibold">{t('privacy.confirmTitle')}</p>
          <p>{t('privacy.confirmText')}</p>
          <div className="flex gap-2">
            <button
              type="button"
              className="min-h-12 rounded bg-santa-700 px-4 font-semibold text-white disabled:opacity-60"
              disabled={del.isPending}
              onClick={() => del.mutate()}
            >
              {t('privacy.confirm')}
            </button>
            <button
              type="button"
              className="min-h-12 rounded border border-ink-900 px-4"
              onClick={() => setConfirming(false)}
            >
              {t('privacy.cancel')}
            </button>
          </div>
        </div>
      )}
      {del.isError && (
        <p role="alert" className="rounded bg-santa-700 p-3 text-white">
          {t(errorKey(del.error))}
        </p>
      )}
    </section>
  );
}
