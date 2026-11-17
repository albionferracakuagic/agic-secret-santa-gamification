import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAdminApi, type BoardAction, type CeremonyState } from '../../api/admin';
import { errorKey } from '../../pages/Dashboard';

const btn = 'min-h-12 rounded border border-ink-900 px-4 font-semibold disabled:opacity-50';
const primary = 'min-h-12 rounded bg-pine-900 px-4 font-semibold text-white disabled:opacity-50';
const Err = ({ e }: { e: unknown }) =>
  e ? (
    <p role="alert" className="rounded bg-santa-700 p-3 text-white">
      <ErrText e={e} />
    </p>
  ) : null;
function ErrText({ e }: { e: unknown }) {
  const { t } = useTranslation();
  return <>{t(errorKey(e))}</>;
}

/** Remote for the awards show: start / next / pause / resume / cancel / restart, and tie decisions (aliases only). */
export function CeremonyControls({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const api = useAdminApi();
  const qc = useQueryClient();
  const key = ['ceremony', eventId];
  const st = useQuery({
    queryKey: key,
    queryFn: () => api.ceremony(eventId),
    refetchInterval: 5000,
  });
  const set = (s: CeremonyState) => qc.setQueryData(key, s);
  const act = useMutation({
    mutationFn: (a: 'start' | 'restart' | 'pause' | 'resume' | 'cancel') =>
      api.ceremonyAct(eventId, a),
    onSuccess: set,
  });
  const next = useMutation({
    mutationFn: (from: number) => api.ceremonyNext(eventId, from),
    onSuccess: set,
    onError: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const decide = useMutation({
    mutationFn: (v: { boardKey: string; giftId: string }) =>
      api.decideAward(eventId, v.boardKey, v.giftId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const [picked, setPicked] = useState<Record<string, string>>({});
  const s = st.data;
  const busy = act.isPending || next.isPending;
  return (
    <section aria-labelledby="cer-title" className="space-y-3">
      <h2 id="cer-title" className="text-xl font-semibold">
        {t('ceremonyCtl.title')}
      </h2>
      {s && (
        <>
          <p role="status">
            {t(`ceremonyCtl.status.${s.status}`)} ·{' '}
            {t('ceremonyCtl.step', { index: s.index, total: s.total })}
          </p>
          {s.blockers.length > 0 && (
            <ul className="list-disc pl-5" data-testid="ceremony-blockers">
              {s.blockers.map((b) => (
                <li key={b}>{t(`ceremonyCtl.blocker.${b}`)}</li>
              ))}
            </ul>
          )}
          {s.outline.length > 0 && (
            <p className="text-sm" data-testid="ceremony-outline">
              {t('ceremonyCtl.outline')}: {s.outline.join(' → ')}
            </p>
          )}
          {s.pendingDecisions.map((d) => (
            <fieldset key={d.boardKey} className="space-y-2 rounded border border-ink-900/30 p-3">
              <legend className="font-semibold">
                {t('ceremonyCtl.tie', {
                  board: t(`board.${d.boardKey}`, { defaultValue: d.boardKey.replace(/_/g, ' ') }),
                })}
              </legend>
              {d.candidates.map((c) => (
                <label key={c.giftId} className="flex min-h-12 items-center gap-2">
                  <input
                    type="radio"
                    name={`tie-${d.boardKey}`}
                    checked={picked[d.boardKey] === c.giftId}
                    onChange={() => setPicked((p) => ({ ...p, [d.boardKey]: c.giftId }))}
                  />
                  {c.label}
                </label>
              ))}
              <button
                type="button"
                className={primary}
                disabled={!picked[d.boardKey] || decide.isPending}
                onClick={() => decide.mutate({ boardKey: d.boardKey, giftId: picked[d.boardKey]! })}
              >
                {t('ceremonyCtl.decide')}
              </button>
            </fieldset>
          ))}
          <div className="flex flex-wrap gap-2">
            {(s.status === 'idle' || s.status === 'cancelled' || s.status === 'done') && (
              <button
                type="button"
                className={primary}
                disabled={busy || (s.status === 'idle' && !s.canStart)}
                onClick={() => act.mutate(s.status === 'idle' ? 'start' : 'restart')}
              >
                {t(s.status === 'idle' ? 'ceremonyCtl.start' : 'ceremonyCtl.restart')}
              </button>
            )}
            {(s.status === 'running' || s.status === 'paused') && (
              <button
                type="button"
                className={primary}
                disabled={busy}
                onClick={() => next.mutate(s.index)}
              >
                {t('ceremonyCtl.next')}
              </button>
            )}
            {s.status === 'running' && (
              <button
                type="button"
                className={btn}
                disabled={busy}
                onClick={() => act.mutate('pause')}
              >
                {t('ceremonyCtl.pause')}
              </button>
            )}
            {s.status === 'paused' && (
              <button
                type="button"
                className={btn}
                disabled={busy}
                onClick={() => act.mutate('resume')}
              >
                {t('ceremonyCtl.resume')}
              </button>
            )}
            {(s.status === 'running' || s.status === 'paused') && (
              <button
                type="button"
                className={btn}
                disabled={busy}
                onClick={() => act.mutate('cancel')}
              >
                {t('ceremonyCtl.cancel')}
              </button>
            )}
          </div>
        </>
      )}
      <Err e={st.error ?? act.error ?? next.error ?? decide.error} />
    </section>
  );
}

/** Live boards console (masked: no entries or counts). Small cohorts need an explicit acknowledgement to go live. */
export function BoardsConsole({ eventId }: { eventId: string }) {
  const { t, i18n } = useTranslation();
  const api = useAdminApi();
  const qc = useQueryClient();
  const key = ['boards', eventId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.boards(eventId),
    refetchInterval: 10_000,
  });
  const [ack, setAck] = useState<Record<string, boolean>>({});
  const act = useMutation({
    mutationFn: (v: { boardKey: string; action: BoardAction }) =>
      api.boardAction(eventId, v.boardKey, v.action, ack[v.boardKey]),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const lang = i18n.language;
  return (
    <section aria-labelledby="boards-title" className="space-y-3">
      <h2 id="boards-title" className="text-xl font-semibold">
        {t('boardsCtl.title')}
      </h2>
      {q.data && (
        <p className="text-sm">{t('boardsCtl.cadence', { seconds: q.data.cadenceSeconds })}</p>
      )}
      <ul className="space-y-3">
        {q.data?.boards.map((b) => {
          const needsAck = !b.liveAllowed && b.state === 'hidden';
          return (
            <li
              key={b.boardKey}
              className="space-y-2 rounded border border-ink-900/20 p-3"
              data-board={b.boardKey}
            >
              <p className="font-semibold">{b.label[lang] ?? b.label['en'] ?? b.boardKey}</p>
              <p role="status">
                {t(`boardsCtl.state.${b.state}`)}
                {b.forced && ` · ${t('boardsCtl.forced')}`}
                {b.publishableNow
                  ? ` · ${t('boardsCtl.publishable')}`
                  : ` · ${t('boardsCtl.notPublishable')}`}
              </p>
              {needsAck && (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={!!ack[b.boardKey]}
                    onChange={(e) => setAck((a) => ({ ...a, [b.boardKey]: e.target.checked }))}
                  />
                  <span>{t('boardsCtl.smallCohort')}</span>
                </label>
              )}
              <div className="flex flex-wrap gap-2">
                {b.state === 'hidden' && (
                  <button
                    type="button"
                    className={primary}
                    disabled={act.isPending || (needsAck && !ack[b.boardKey])}
                    onClick={() => act.mutate({ boardKey: b.boardKey, action: 'enable' })}
                  >
                    {t('boardsCtl.enable')}
                  </button>
                )}
                {b.state === 'live' && (
                  <button
                    type="button"
                    className={btn}
                    onClick={() => act.mutate({ boardKey: b.boardKey, action: 'pause' })}
                  >
                    {t('boardsCtl.pause')}
                  </button>
                )}
                {b.state === 'paused' && (
                  <button
                    type="button"
                    className={btn}
                    onClick={() => act.mutate({ boardKey: b.boardKey, action: 'resume' })}
                  >
                    {t('boardsCtl.resume')}
                  </button>
                )}
                {b.state !== 'hidden' && (
                  <button
                    type="button"
                    className={btn}
                    onClick={() => act.mutate({ boardKey: b.boardKey, action: 'hide' })}
                  >
                    {t('boardsCtl.hide')}
                  </button>
                )}
                <button
                  type="button"
                  className={btn}
                  disabled={!b.publishableNow}
                  onClick={() => act.mutate({ boardKey: b.boardKey, action: 'publish_now' })}
                >
                  {t('boardsCtl.publishNow')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <Err e={q.error ?? act.error} />
    </section>
  );
}
