import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOrganizerApi, type ClaimCodes } from '../../api/organizer';
import { errorKey } from '../../pages/Dashboard';

const btn = 'min-h-12 rounded border border-ink-900 px-4 font-semibold disabled:opacity-50';

const toCsv = (c: ClaimCodes) =>
  'name,code\n' + c.codes.map((r) => `"${r.displayName.replace(/"/g, '""')}",${r.code}`).join('\n');

/** Pending approvals + claim code / email-link export for unclaimed roster entries. */
export function ApprovalPanel({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const api = useOrganizerApi();
  const qc = useQueryClient();
  const [codes, setCodes] = useState<ClaimCodes>();
  const [sent, setSent] = useState<number>();
  const roster = useQuery({
    queryKey: ['roster', eventId],
    queryFn: () => api.listRoster(eventId),
    refetchInterval: 10_000,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['roster', eventId] });
  const approve = useMutation({
    mutationFn: (id: string) => api.approve(eventId, id),
    onSuccess: refresh,
  });
  const gen = useMutation({ mutationFn: () => api.claimCodes(eventId), onSuccess: setCodes });
  const mail = useMutation({
    mutationFn: () => api.sendEmailLinks(eventId),
    onSuccess: (r) => setSent(r.sent),
  });
  const pending = roster.data?.participants.filter((p) => p.status === 'pending') ?? [];

  const download = () => {
    if (!codes) return;
    const url = URL.createObjectURL(new Blob([toCsv(codes)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'claim-codes.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section aria-labelledby="approvals-title" className="space-y-3">
      <h2 id="approvals-title" className="text-xl font-semibold">
        {t('approvals.title')}
      </h2>
      {pending.length === 0 ? (
        <p>{t('approvals.none')}</p>
      ) : (
        <ul className="space-y-2">
          {pending.map((p) => (
            <li key={p.participantId} className="flex items-center justify-between gap-2">
              <span>{p.displayName}</span>
              <button
                type="button"
                className={btn}
                disabled={approve.isPending}
                onClick={() => approve.mutate(p.participantId)}
                aria-label={t('approvals.approveName', { name: p.displayName })}
              >
                {t('approvals.approve')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} disabled={gen.isPending} onClick={() => gen.mutate()}>
          {t('approvals.codes')}
        </button>
        <button
          type="button"
          className={btn}
          disabled={mail.isPending}
          onClick={() => mail.mutate()}
        >
          {t('approvals.emailLinks')}
        </button>
      </div>
      {sent !== undefined && <p role="status">{t('approvals.sent', { count: sent })}</p>}
      {codes && (
        <div className="space-y-2">
          <p className="text-sm">{t('approvals.codesOnce')}</p>
          <table className="w-full text-left">
            <caption className="sr-only">{t('approvals.codes')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('approvals.name')}</th>
                <th scope="col">{t('approvals.code')}</th>
              </tr>
            </thead>
            <tbody>
              {codes.codes.map((c) => (
                <tr key={c.participantId}>
                  <td>{c.displayName}</td>
                  <td className="font-mono">{c.code}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className={btn} onClick={download}>
            {t('approvals.download')}
          </button>
        </div>
      )}
      {(approve.isError || gen.isError || mail.isError || roster.isError) && (
        <p role="alert" className="rounded bg-santa-700 p-3 text-white">
          {t(errorKey(approve.error ?? gen.error ?? mail.error ?? roster.error))}
        </p>
      )}
    </section>
  );
}

/** Event-wide reactions switch plus per-person mute (names only, no data beyond the roster). */
export function ReactionSettings({
  eventId,
  initial,
}: {
  eventId: string;
  initial?: boolean | undefined;
}) {
  const { t } = useTranslation();
  const api = useOrganizerApi();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState<boolean | undefined>(initial);
  const roster = useQuery({
    queryKey: ['roster', eventId],
    queryFn: () => api.listRoster(eventId),
  });
  const toggle = useMutation({
    mutationFn: (on: boolean) => api.setReactionsEnabled(eventId, on).then(() => on),
    onSuccess: setEnabled,
  });
  const mute = useMutation({
    mutationFn: (a: { id: string; muted: boolean }) => api.muteParticipant(eventId, a.id, a.muted),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['roster', eventId] }),
  });
  const active = roster.data?.participants.filter((p) => p.status === 'active') ?? [];

  return (
    <section aria-labelledby="react-set-title" className="space-y-3">
      <h2 id="react-set-title" className="text-xl font-semibold">
        {t('reactionSettings.title')}
      </h2>
      <div className="flex gap-2">
        <button type="button" className={btn} onClick={() => toggle.mutate(true)}>
          {t('reactionSettings.enable')}
        </button>
        <button type="button" className={btn} onClick={() => toggle.mutate(false)}>
          {t('reactionSettings.disable')}
        </button>
      </div>
      <p role="status">
        {enabled === undefined
          ? ''
          : t(enabled ? 'reactionSettings.nowOn' : 'reactionSettings.nowOff')}
      </p>
      {active.length > 0 && (
        <ul className="space-y-2">
          {active.map((p) => (
            <li key={p.participantId} className="flex items-center justify-between gap-2">
              <span>{p.displayName}</span>
              <button
                type="button"
                className={btn}
                aria-pressed={p.reactionsMuted}
                aria-label={`${t(p.reactionsMuted ? 'reactionSettings.unmute' : 'reactionSettings.mute')} ${p.displayName}`}

                onClick={() => mute.mutate({ id: p.participantId, muted: !p.reactionsMuted })}
              >
                {t(p.reactionsMuted ? 'reactionSettings.unmute' : 'reactionSettings.mute')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {(toggle.isError || mute.isError) && (
        <p role="alert" className="rounded bg-santa-700 p-3 text-white">
          {t(errorKey(toggle.error ?? mute.error))}
        </p>
      )}
    </section>
  );
}
