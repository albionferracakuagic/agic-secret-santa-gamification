import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { INTEGRITY_ANOMALIES } from '@santa/contracts';
import { useAdminApi } from '../../api/admin';
import { useOrganizerApi } from '../../api/organizer';
import { errorKey } from '../../pages/Dashboard';
import { useUnmask } from './Unmask';

const btn = 'min-h-12 rounded border border-ink-900 px-4 font-semibold disabled:opacity-50';
const Err = ({ e }: { e: unknown }) => {
  const { t } = useTranslation();
  return e ? (
    <p role="alert" className="rounded bg-santa-700 p-3 text-white">
      {t(errorKey(e))}
    </p>
  ) : null;
};

/** Counts only: participants by status, gifts, voting, ceremony. No names, no vote content. */
export function StatsCard({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const api = useAdminApi();
  const q = useQuery({
    queryKey: ['stats', eventId],
    queryFn: () => api.stats(eventId),
    refetchInterval: 10_000,
  });
  const s = q.data;
  return (
    <section aria-labelledby="stats-title" className="space-y-2">
      <h2 id="stats-title" className="text-xl font-semibold">
        {t('adminStats.title')}
      </h2>
      {s && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1" data-testid="stats">
          <dt>{t('adminStats.participants')}</dt>
          <dd>
            {Object.entries(s.participants)
              .map(([k, n]) => `${t(`adminStats.status.${k}`)} ${n}`)
              .join(' · ')}
          </dd>
          <dt>{t('adminStats.gifts')}</dt>
          <dd>{t('adminStats.giftsLine', { ...s.gifts })}</dd>
          <dt>{t('adminStats.voting')}</dt>
          <dd>
            {t(`adminStats.votingStatus.${s.voting.status}`)}
            {s.voting.votedCount !== null &&
              ` · ${t('voting.voted', { count: s.voting.votedCount })}`}
          </dd>
          <dt>{t('adminStats.ceremony')}</dt>
          <dd>{t(`ceremonyCtl.status.${s.ceremony}`)}</dd>
        </dl>
      )}
      <Err e={q.error} />
    </section>
  );
}

/** Integrity report (masked aggregates). Details need an active unmask session and are listed by id only. */
export function IntegrityPanel({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const api = useAdminApi();
  const { grant } = useUnmask();
  const q = useQuery({ queryKey: ['integrity', eventId], queryFn: () => api.integrity(eventId) });
  const details = useMutation({ mutationFn: () => api.integrityDetails(eventId, grant!.grantId) });
  const r = q.data;
  return (
    <section aria-labelledby="integrity-title" className="space-y-2">
      <h2 id="integrity-title" className="text-xl font-semibold">
        {t('integrity.title')}
      </h2>
      {r && (
        <>
          <p role="status">{t(r.clean ? 'integrity.clean' : 'integrity.issues')}</p>
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{t('integrity.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('integrity.category')}</th>
                <th scope="col">{t('integrity.voters')}</th>
                <th scope="col">{t('integrity.floor')}</th>
              </tr>
            </thead>
            <tbody>
              {r.categories.map((c) => (
                <tr key={c.boardKey}>
                  <td>
                    {t(`board.${c.boardKey}`, { defaultValue: c.boardKey.replace(/_/g, ' ') })}
                  </td>
                  <td>{c.voters}</td>
                  <td>{c.belowPrivacyFloor ? t('integrity.below') : t('integrity.ok')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="list-disc pl-5">
            {INTEGRITY_ANOMALIES.map((a) => (
              <li key={a}>
                {t(`integrity.anomaly.${a}`)}: {r.anomalies[a] ?? 0}
              </li>
            ))}
          </ul>
        </>
      )}
      <button
        type="button"
        className={btn}
        disabled={!grant || details.isPending}
        onClick={() => details.mutate()}
      >
        {t('integrity.details')}
      </button>
      {!grant && <p className="text-sm">{t('integrity.needUnmask')}</p>}
      {details.data && (
        <ul className="list-disc pl-5" data-testid="integrity-details">
          {details.data.items.length === 0 && <li>{t('integrity.noDetails')}</li>}
          {details.data.items.map((i, n) => (
            <li key={n}>
              {t(`integrity.anomaly.${i.anomaly}`)} · {i.boardKey} · {i.voterId} → {i.giftId} ·{' '}
              {i.at}
            </li>
          ))}
        </ul>
      )}
      <Err e={q.error ?? details.error} />
    </section>
  );
}

/** Roster with remove-participant (two-step confirm). Removal before voting closes also drops their votes. */
export function RemoveParticipants({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const org = useOrganizerApi();
  const api = useAdminApi();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<string>();
  const roster = useQuery({
    queryKey: ['roster', eventId],
    queryFn: () => org.listRoster(eventId),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.removeParticipant(eventId, id),
    onSuccess: () => {
      setConfirming(undefined);
      void qc.invalidateQueries({ queryKey: ['roster', eventId] });
    },
  });
  const list =
    roster.data?.participants.filter((p) => p.status === 'active' || p.status === 'pending') ?? [];
  return (
    <section aria-labelledby="remove-title" className="space-y-2">
      <h2 id="remove-title" className="text-xl font-semibold">
        {t('removeCtl.title')}
      </h2>
      <ul className="space-y-2">
        {list.map((p) => (
          <li key={p.participantId} className="flex flex-wrap items-center justify-between gap-2">
            <span>{p.displayName}</span>
            {confirming === p.participantId ? (
              <span className="flex gap-2">
                <button
                  type="button"
                  className="min-h-12 rounded bg-santa-700 px-4 font-semibold text-white"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(p.participantId)}
                >
                  {t('removeCtl.confirm', { name: p.displayName })}
                </button>
                <button type="button" className={btn} onClick={() => setConfirming(undefined)}>
                  {t('privacy.cancel')}
                </button>
              </span>
            ) : (
              <button
                type="button"
                className={btn}
                aria-label={`${t('removeCtl.remove')} ${p.displayName}`}
                onClick={() => setConfirming(p.participantId)}
              >
                {t('removeCtl.remove')}
              </button>
            )}
          </li>
        ))}
      </ul>
      <Err e={roster.error ?? remove.error} />
    </section>
  );
}

/** Gift moderation by alias: hide/unhide, remove photo, rename. No giver or recipient shown. */
export function GiftModerationPanel({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const org = useOrganizerApi();
  const api = useAdminApi();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['gifts', eventId], queryFn: () => org.listGifts(eventId) });
  const patch = useMutation({
    mutationFn: (v: {
      id: string;
      p: { name?: string; removePhoto?: boolean; hidden?: boolean };
    }) => api.moderateGift(eventId, v.id, v.p),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['gifts', eventId] }),
  });
  const [names, setNames] = useState<Record<string, string>>({});
  return (
    <section aria-labelledby="mod-title" className="space-y-2">
      <h2 id="mod-title" className="text-xl font-semibold">
        {t('moderation.title')}
      </h2>
      <ul className="space-y-3">
        {q.data?.map((g) => (
          <li key={g.giftId} className="space-y-1 rounded border border-ink-900/20 p-2">
            <p className="font-semibold">
              {g.alias}
              {g.hidden && ` · ${t('moderation.hidden')}`}
            </p>
            <label className="block">
              <span className="sr-only">{`${t('moderation.name')} ${g.alias}`}</span>
              <input
                className="block min-h-11 w-full rounded border border-ink-900/40 bg-white px-2"
                value={names[g.giftId] ?? g.name}
                onChange={(e) => setNames((n) => ({ ...n, [g.giftId]: e.target.value }))}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={btn}
                disabled={!names[g.giftId] || names[g.giftId] === g.name}
                aria-label={`${t('moderation.rename')} ${g.alias}`}
                onClick={() => patch.mutate({ id: g.giftId, p: { name: names[g.giftId]!.trim() } })}
              >
                {t('moderation.rename')}
              </button>
              {g.photoUrl && (
                <button
                  type="button"
                  className={btn}
                  aria-label={`${t('moderation.removePhoto')} ${g.alias}`}
                  onClick={() => patch.mutate({ id: g.giftId, p: { removePhoto: true } })}
                >
                  {t('moderation.removePhoto')}
                </button>
              )}
              <button
                type="button"
                className={btn}
                aria-label={`${t(g.hidden ? 'moderation.unhide' : 'moderation.hide')} ${g.alias}`}
                onClick={() => patch.mutate({ id: g.giftId, p: { hidden: !g.hidden } })}
              >
                {t(g.hidden ? 'moderation.unhide' : 'moderation.hide')}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <Err e={q.error ?? patch.error} />
    </section>
  );
}

/** Audit log viewer (actor, action, target, reason, time). */
export function AuditViewer({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const api = useAdminApi();
  const q = useQuery({ queryKey: ['audit', eventId], queryFn: () => api.audit(eventId) });
  return (
    <section aria-labelledby="audit-title" className="space-y-2">
      <h2 id="audit-title" className="text-xl font-semibold">
        {t('audit.title')}
      </h2>
      {q.data && q.data.length === 0 && <p>{t('audit.none')}</p>}
      {q.data && q.data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="audit">
            <caption className="sr-only">{t('audit.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('audit.at')}</th>
                <th scope="col">{t('audit.actor')}</th>
                <th scope="col">{t('audit.action')}</th>
                <th scope="col">{t('audit.target')}</th>
                <th scope="col">{t('audit.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((e) => (
                <tr key={e.id}>
                  <td>{e.at}</td>
                  <td>{e.actor}</td>
                  <td>{e.action}</td>
                  <td>{e.target ?? '—'}</td>
                  <td>{e.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Err e={q.error} />
    </section>
  );
}
