import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { usePhase3Api } from '../api/phase3';

/** /link?token=… : the magic link from the account-link email. One generic message for any wrong/used/expired token. */
export default function LinkConfirm() {
  const { t } = useTranslation();
  const api = usePhase3Api();
  const token = useSearchParams()[0].get('token') ?? '';
  const confirm = useMutation({ mutationFn: (tk: string) => api.confirmAccountLink(tk) });
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !token) return;
    started.current = true;
    confirm.mutate(token);
  }, [token, confirm]);
  const failed = !token || confirm.isError;
  return (
    <section aria-labelledby="link-title" className="space-y-4">
      <h1 id="link-title" className="text-2xl font-bold">
        {t('history.lifetime')}
      </h1>
      <p role="status">
        {failed
          ? t('history.linkFailed')
          : confirm.isSuccess
            ? t('history.linkDone')
            : t('history.linkConfirming')}
      </p>
      <Link to="/e" className="underline">
        {t('history.home')}
      </Link>
    </section>
  );
}
