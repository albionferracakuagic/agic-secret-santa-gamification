import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MISSION_NOTE_MAX } from '@santa/contracts';
import { usePhase2Api, type MyMission } from '../../api/phase2';
import { useLocalized } from '../../lib/localized';
import { emitFx } from '../../fx/bus';
import { errorKey } from '../../pages/Dashboard';

const btn = 'min-h-12 rounded px-4 font-semibold disabled:opacity-50';

/** FR-028..030: the caller's own, private missions. Hidden while `features.missions` is off. */
export function MissionsPanel() {
  const { t } = useTranslation();
  const api = usePhase2Api();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['my-missions'], queryFn: () => api.myMissions() });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['my-missions'] });
  const optOut = useMutation({
    mutationFn: (v: boolean) => api.setMissionOptOut(v),
    onSuccess: refresh,
  });
  const s = q.data;
  if (!s?.enabled) return null;
  return (
    <section aria-labelledby="missions-title" className="space-y-3" data-testid="missions-panel">
      <h2 id="missions-title" className="text-xl font-semibold">
        {t('missions.title')}
      </h2>
      <p>{t('missions.privateNote')}</p>
      <label className="flex min-h-12 items-center gap-2">
        <input
          type="checkbox"
          className="h-6 w-6"
          checked={s.optedOut}
          disabled={optOut.isPending}
          onChange={(e) => optOut.mutate(e.target.checked)}
        />
        {t('missions.optOut')}
      </label>
      {s.optedOut ? (
        <p role="status">{t('missions.optedOut')}</p>
      ) : s.missions.length === 0 ? (
        <p>{t('missions.none')}</p>
      ) : (
        <ul className="space-y-3">
          {s.missions.map((m) => (
            <Mission key={m.assignmentId} m={m} onChange={refresh} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Mission({ m, onChange }: { m: MyMission; onChange: () => void }) {
  const { t } = useTranslation();
  const api = usePhase2Api();
  const loc = useLocalized();
  const [note, setNote] = useState('');
  const submit = useMutation({
    mutationFn: () => api.submitMission(m.assignmentId, note.trim() || undefined),
    onSuccess: () => {
      onChange();
      emitFx('mission_completed');
    },
  });
  const swap = useMutation({
    mutationFn: () => api.reassignMission(m.assignmentId),
    onSuccess: onChange,
  });
  const open = m.status === 'assigned' || m.status === 'rejected';
  const noteId = `note-${m.assignmentId}`;
  return (
    <li className="space-y-2 rounded border border-ink-900/30 bg-white p-3">
      <h3 className="font-semibold">🕵️ {loc(m.title)}</h3>
      <p>{loc(m.description)}</p>
      <p role="status">
        {m.completed ? t('missions.completed') : t(`missions.status.${m.status}`)}
      </p>
      {open && (
        <>
          <label htmlFor={noteId} className="block">
            {t('missions.note')}
            <input
              id={noteId}
              className="mt-1 block min-h-12 w-full rounded border border-ink-900/40 bg-white px-3"
              value={note}
              maxLength={MISSION_NOTE_MAX}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`${btn} bg-pine-900 text-white`}
              disabled={submit.isPending}
              onClick={() => submit.mutate()}
            >
              {t('missions.submit')}
            </button>
            <button
              type="button"
              className={`${btn} border border-ink-900`}
              disabled={swap.isPending || m.swapsLeft === 0}
              onClick={() => swap.mutate()}
            >
              {t('missions.reassign', { n: m.swapsLeft })}
            </button>
          </div>
        </>
      )}
      {(submit.isError || swap.isError) && (
        <p role="alert">{t(errorKey(submit.error ?? swap.error))}</p>
      )}
    </li>
  );
}
