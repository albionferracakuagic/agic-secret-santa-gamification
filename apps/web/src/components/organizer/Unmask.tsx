import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { useAdminApi, type UnmaskGrant } from '../../api/admin';
import { errorKey } from '../../pages/Dashboard';

interface UnmaskCtx {
  grant: UnmaskGrant | undefined;
  set(g: UnmaskGrant | undefined): void;
}
const Ctx = createContext<UnmaskCtx>({ grant: undefined, set: () => undefined });
export const useUnmask = () => useContext(Ctx);

/** Holds the active unmask grant for the console; it clears itself at expiry. */
export function UnmaskProvider({ children }: { children: ReactNode }) {
  const [grant, set] = useState<UnmaskGrant>();
  useEffect(() => {
    if (!grant) return;
    const ms = Date.parse(grant.expiresAt) - Date.now();
    const id = setTimeout(() => set(undefined), Math.max(0, ms));
    return () => clearTimeout(id);
  }, [grant]);
  return <Ctx.Provider value={{ grant, set }}>{children}</Ctx.Provider>;
}

/** Persistent "unmasked" banner with a live countdown and an immediate end-session control. */
export function UnmaskBanner({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const api = useAdminApi();
  const { grant, set } = useUnmask();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const end = useMutation({
    mutationFn: (id: string) => api.revokeUnmask(eventId, id),
    onSuccess: () => set(undefined),
  });
  if (!grant) return null;
  const left = Math.max(0, Math.ceil((Date.parse(grant.expiresAt) - Date.now()) / 1000));
  return (
    <div
      role="region"
      aria-label={t('unmask.bannerLabel')}
      data-testid="unmask-banner"
      className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-2 rounded border-4 border-santa-700 bg-gold-400 p-3 font-semibold text-ink-900"
    >
      <span>
        {t('unmask.banner')}{' '}
        <span className="tabular-nums">
          {String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}
        </span>
      </span>
      <button
        type="button"
        className="min-h-11 rounded bg-ink-900 px-4 text-white disabled:opacity-60"
        disabled={end.isPending}
        onClick={() => end.mutate(grant.grantId)}
      >
        {t('unmask.end')}
      </button>
    </div>
  );
}

/** Start an audited unmask session: stated reason + explicit confirmation. */
export function UnmaskForm({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const api = useAdminApi();
  const { grant, set } = useUnmask();
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const start = useMutation({
    mutationFn: () => api.unmask(eventId, reason.trim()),
    onSuccess: (g) => {
      set(g);
      setReason('');
      setConfirm(false);
    },
  });
  if (grant) return null;
  const ok = reason.trim().length >= 8 && confirm;
  return (
    <section aria-labelledby="unmask-title" className="space-y-3">
      <h2 id="unmask-title" className="text-xl font-semibold">
        {t('unmask.title')}
      </h2>
      <p className="text-sm">{t('unmask.explain')}</p>
      <label className="block">
        {t('unmask.reason')}
        <textarea
          className="mt-1 block min-h-24 w-full rounded border border-ink-900/40 bg-white p-2"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
        <span>{t('unmask.confirm')}</span>
      </label>
      <button
        type="button"
        className="min-h-12 rounded bg-santa-700 px-4 font-semibold text-white disabled:opacity-50"
        disabled={!ok || start.isPending}
        onClick={() => start.mutate()}
      >
        {t('unmask.start')}
      </button>
      {start.isError && (
        <p role="alert" className="rounded bg-santa-700 p-3 text-white">
          {t(errorKey(start.error))}
        </p>
      )}
    </section>
  );
}
