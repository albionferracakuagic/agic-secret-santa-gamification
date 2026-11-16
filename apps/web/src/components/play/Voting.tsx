import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PublicGiftListOutput } from '@santa/contracts';
import { ApiError } from '../../api/client';
import { usePlayApi, type OwnVotes } from '../../api/play';
import { emitFx } from '../../fx/bus';
import { Countdown } from '../Countdown';

type Loc = Record<string, string>;
const pick = (m: Loc | null | undefined, lang: string) =>
  m ? (m[lang] ?? m['en'] ?? Object.values(m)[0] ?? '') : '';

/**
 * Voting: one selection per category, own gift disabled, changes allowed while open, own picks summary,
 * published voted counter and a server-clock countdown. Never shows anyone else's selection.
 */
export function VotingPanel({
  gifts,
  votedCount,
  endsAt,
  now,
}: {
  gifts: PublicGiftListOutput | undefined;
  votedCount: number | null | undefined;
  endsAt: string | null | undefined;
  now: () => number;
}) {
  const { t, i18n } = useTranslation();
  const api = usePlayApi();
  const qc = useQueryClient();
  const voting = useQuery({ queryKey: ['voting'], queryFn: () => api.voting() });
  const own = useQuery({ queryKey: ['own-votes'], queryFn: () => api.ownVotes() });
  const myGift = useQuery({ queryKey: ['gift'], queryFn: () => api.getGift() });
  const myGiftId = myGift.data?.gift?.giftId;

  const [optimistic, setOptimistic] = useState<Record<string, string>>({});
  const clearOptimistic = (categoryId: string) =>
    setOptimistic((o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== categoryId)));
  const cast = useMutation({
    mutationFn: (v: { categoryId: string; giftId: string }) => api.castVote(v),
    onSuccess: (r) => {
      qc.setQueryData<OwnVotes>(['own-votes'], (o) => ({
        votes: [
          ...(o?.votes ?? []).filter((v) => v.categoryId !== r.categoryId),
          { categoryId: r.categoryId, giftId: r.giftId },
        ],
      }));
      clearOptimistic(r.categoryId);
      emitFx('vote_submitted');
    },
    onError: (_e, v) => clearOptimistic(v.categoryId),
  });

  const v = voting.data;
  if (!v) return <p role="status">{t('a11y.loading')}</p>;
  const open = v.status === 'open';
  const list = gifts?.mode === 'gallery' ? gifts.gifts : [];
  const chosen = new Map((own.data?.votes ?? []).map((x) => [x.categoryId, x.giftId]));
  for (const [cat, giftId] of Object.entries(optimistic)) chosen.set(cat, giftId); // shown before the server answers
  const giftName = (id: string) => list.find((g) => g.giftId === id);
  const end = endsAt ?? v.endsAt;
  const counter = votedCount ?? v.votedCount;

  return (
    <section aria-labelledby="vote-title" className="space-y-4">
      <h2 id="vote-title" className="text-xl font-semibold">
        {t('voting.title')}
      </h2>
      {v.status === 'not_open' && <p role="status">{t('voting.notOpen')}</p>}
      {v.status === 'closed' && <p role="status">{t('voting.closed')}</p>}
      {open && end && (
        <div>
          <p className="text-sm">{t('voting.timeLeft')}</p>
          <Countdown endsAt={end} now={now} className="text-4xl" />
        </div>
      )}
      {counter !== null && counter !== undefined && (
        <p data-testid="voted-count">{t('voting.voted', { count: counter })}</p>
      )}
      {open && list.length === 0 && <p>{t('voting.noGifts')}</p>}
      {v.status !== 'not_open' &&
        v.categories.map((c) => (
          <fieldset key={c.id} className="space-y-2" disabled={!open}>
            <legend className="font-semibold">{pick(c.name, i18n.language)}</legend>
            {c.description && <p className="text-sm">{pick(c.description, i18n.language)}</p>}
            {list.map((g) => {
              const mine = g.giftId === myGiftId;
              return (
                <label
                  key={g.giftId}
                  className="flex min-h-12 items-center gap-3 rounded border border-ink-900/30 bg-white px-3"
                >
                  <input
                    type="radio"
                    name={`cat-${c.id}`}
                    checked={chosen.get(c.id) === g.giftId}
                    disabled={!open || mine}
                    onChange={() => {
                      setOptimistic((o) => ({ ...o, [c.id]: g.giftId }));
                      cast.mutate({ categoryId: c.id, giftId: g.giftId });
                    }}
                  />
                  <span>
                    {g.alias}: {g.name}
                    {mine && <em className="ml-2 text-sm">{t('voting.yours')}</em>}
                  </span>
                </label>
              );
            })}
          </fieldset>
        ))}
      {cast.isError && (
        <p role="alert">
          {t(
            cast.error instanceof ApiError && cast.error.code === 'own_gift'
              ? 'voting.error.own_gift'
              : 'voting.error.generic',
          )}
        </p>
      )}
      <section aria-labelledby="picks-title" className="space-y-1">
        <h3 id="picks-title" className="font-semibold">
          {t('voting.yourPicks')}
        </h3>
        {chosen.size === 0 ? (
          <p>{t('participant.noSelections')}</p>
        ) : (
          <ul className="list-disc pl-5" data-testid="own-picks">
            {v.categories
              .filter((c) => chosen.has(c.id))
              .map((c) => (
                <li key={c.id}>
                  {pick(c.name, i18n.language)}:{' '}
                  {giftName(chosen.get(c.id)!)?.name ?? t('participant.yourPick')}
                </li>
              ))}
          </ul>
        )}
        {open && <p className="text-sm">{t('voting.canChange')}</p>}
      </section>
    </section>
  );
}
