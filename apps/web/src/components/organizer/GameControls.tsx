import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOrganizerApi, type OrganizerGift } from '../../api/organizer';
import { errorKey } from '../../pages/Dashboard';

const btn = 'min-h-12 rounded border border-ink-900 px-4 font-semibold disabled:opacity-50';
const primary = 'min-h-12 rounded bg-pine-900 px-4 font-semibold text-white disabled:opacity-50';

const useErr = (...errs: unknown[]) => errs.find(Boolean);

/** Gift opening: progress, opening mode (random / manual order) and the "open next gift" control. */
export function OpeningControls({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const api = useOrganizerApi();
  const qc = useQueryClient();
  const key = ['opening', eventId];
  const st = useQuery({
    queryKey: key,
    queryFn: () => api.openingState(eventId),
    refetchInterval: 5000,
  });
  const gifts = useQuery({ queryKey: ['gifts', eventId], queryFn: () => api.listGifts(eventId) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['gifts', eventId] });
  };
  const next = useMutation({ mutationFn: () => api.openingNext(eventId), onSuccess: refresh });
  const order = useMutation({
    mutationFn: (o: { mode: 'random' } | { mode: 'manual'; order: string[] }) =>
      api.openingOrder(eventId, o),
    onSuccess: refresh,
  });
  const [manual, setManual] = useState<OrganizerGift[]>([]);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing)
      setManual((gifts.data ?? []).filter((g) => g.status === 'registered' && !g.hidden));
  }, [gifts.data, editing]);

  const move = (i: number, d: -1 | 1) =>
    setManual((m) => {
      const j = i + d;
      if (j < 0 || j >= m.length) return m;
      const c = [...m];
      [c[i], c[j]] = [c[j]!, c[i]!];
      return c;
    });

  const s = st.data;
  const err = useErr(next.error, order.error, st.error);
  return (
    <section aria-labelledby="opening-ctl-title" className="space-y-3">
      <h2 id="opening-ctl-title" className="text-xl font-semibold">
        {t('openingCtl.title')}
      </h2>
      {s && (
        <p role="status">
          {s.allOpened
            ? t('openingCtl.allOpened')
            : t('opening.progress', { opened: s.openedCount, total: s.total })}
        </p>
      )}
      <button
        type="button"
        className={`${primary} w-full`}
        disabled={next.isPending || !s || s.allOpened}
        onClick={() => next.mutate()}
      >
        {t('openingCtl.next')}
      </button>
      {s && s.openedCount === 0 && (
        <fieldset className="space-y-2">
          <legend className="font-semibold">{t('openingCtl.mode')}</legend>
          <label className="flex min-h-12 items-center gap-2">
            <input
              type="radio"
              name="open-mode"
              checked={s.mode === 'random' && !editing}
              onChange={() => {
                setEditing(false);
                order.mutate({ mode: 'random' });
              }}
            />
            {t('openingCtl.random')}
          </label>
          <label className="flex min-h-12 items-center gap-2">
            <input
              type="radio"
              name="open-mode"
              checked={s.mode === 'manual' || editing}
              onChange={() => setEditing(true)}
            />
            {t('openingCtl.manual')}
          </label>
          {editing && (
            <div className="space-y-2">
              <ol className="space-y-1">
                {manual.map((g, i) => (
                  <li key={g.giftId} className="flex items-center justify-between gap-2">
                    <span>
                      {i + 1}. {g.alias}
                    </span>
                    <span className="flex gap-1">
                      <button
                        type="button"
                        className={btn}
                        onClick={() => move(i, -1)}
                        aria-label={`${t('openingCtl.up')} ${g.alias}`}
                        disabled={i === 0}
                      >
                        {t('openingCtl.up')}
                      </button>
                      <button
                        type="button"
                        className={btn}
                        onClick={() => move(i, 1)}
                        aria-label={`${t('openingCtl.down')} ${g.alias}`}
                        disabled={i === manual.length - 1}
                      >
                        {t('openingCtl.down')}
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
              <button
                type="button"
                className={primary}
                disabled={manual.length === 0 || order.isPending}
                onClick={() => {
                  order.mutate({ mode: 'manual', order: manual.map((g) => g.giftId) });
                  setEditing(false);
                }}
              >
                {t('openingCtl.saveOrder')}
              </button>
            </div>
          )}
        </fieldset>
      )}
      {err != null && (
        <p role="alert" className="rounded bg-santa-700 p-3 text-white">
          {t(errorKey(err))}
        </p>
      )}
    </section>
  );
}

/** Opens voting (with optional timer) from the opening phase, or closes it. */
export function VotingControls({ eventId, phase }: { eventId: string; phase: string }) {
  const { t } = useTranslation();
  const api = useOrganizerApi();
  const [minutes, setMinutes] = useState('10');
  const [closed, setClosed] = useState<{ locked: number; publishable: number }>();
  const open = useMutation({
    mutationFn: () => api.openVoting(eventId, minutes ? Number(minutes) : undefined),
  });
  const close = useMutation({
    mutationFn: () => api.closeVoting(eventId),
    onSuccess: (r) =>
      setClosed({ locked: r.categoriesLocked, publishable: r.categoriesPublishable }),
  });
  const err = useErr(open.error, close.error);
  return (
    <section aria-labelledby="voting-ctl-title" className="space-y-3">
      <h2 id="voting-ctl-title" className="text-xl font-semibold">
        {t('votingCtl.title')}
      </h2>
      {phase === 'gift_opening' && (
        <>
          <label className="block">
            {t('votingCtl.minutes')}
            <input
              type="number"
              min={1}
              max={240}
              className="mt-1 block min-h-12 w-full rounded border border-ink-900/40 bg-white px-3"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </label>
          <button
            type="button"
            className={primary}
            disabled={open.isPending}
            onClick={() => open.mutate()}
          >
            {t('votingCtl.open')}
          </button>
          {open.isSuccess && <p role="status">{t('votingCtl.opened')}</p>}
        </>
      )}
      {phase === 'voting' && (
        <>
          <button
            type="button"
            className={btn}
            disabled={close.isPending}
            onClick={() => close.mutate()}
          >
            {t('votingCtl.close')}
          </button>
          {closed && (
            <p role="status">
              {t('votingCtl.closedInfo', {
                locked: closed.locked,
                publishable: closed.publishable,
              })}
            </p>
          )}
        </>
      )}
      {err != null && (
        <p role="alert" className="rounded bg-santa-700 p-3 text-white">
          {t(errorKey(err))}
        </p>
      )}
    </section>
  );
}

/** Giver reveal: per gift (alias only, no names) or all at once. Irreversible, so confirmed in text. */
export function RevealControls({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const api = useOrganizerApi();
  const qc = useQueryClient();
  const gifts = useQuery({ queryKey: ['gifts', eventId], queryFn: () => api.listGifts(eventId) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['gifts', eventId] });
  const one = useMutation({
    mutationFn: (id: string) => api.revealGift(eventId, id),
    onSuccess: refresh,
  });
  const all = useMutation({ mutationFn: () => api.revealAll(eventId), onSuccess: refresh });
  const list = (gifts.data ?? []).filter((g) => !g.hidden);
  const err = useErr(one.error, all.error);
  return (
    <section aria-labelledby="reveal-ctl-title" className="space-y-3">
      <h2 id="reveal-ctl-title" className="text-xl font-semibold">
        {t('revealCtl.title')}
      </h2>
      <p className="text-sm">{t('revealCtl.irreversible')}</p>
      <ul className="space-y-2">
        {list.map((g) => (
          <li key={g.giftId} className="flex items-center justify-between gap-2">
            <span>
              {g.alias}: {g.name}
            </span>
            {g.status === 'revealed' ? (
              <span>{t('revealCtl.done')}</span>
            ) : (
              <button
                type="button"
                className={btn}
                disabled={one.isPending}
                onClick={() => one.mutate(g.giftId)}
                aria-label={`${t('revealCtl.one')} ${g.alias}`}
              >
                {t('revealCtl.one')}
              </button>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className={primary}
        disabled={all.isPending || list.every((g) => g.status === 'revealed')}
        onClick={() => all.mutate()}
      >
        {t('revealCtl.all')}
      </button>
      {all.data && <p role="status">{t('revealCtl.revealed', { count: all.data.revealed })}</p>}
      {err != null && (
        <p role="alert" className="rounded bg-santa-700 p-3 text-white">
          {t(errorKey(err))}
        </p>
      )}
    </section>
  );
}
