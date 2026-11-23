import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  SHOW_CHOICE_OPTIONS,
  type RevealViewOutput,
  type ShowChoiceOption,
} from '@santa/contracts';
import { useTranslation } from 'react-i18next';
import { revealShowApi } from '../../api/revealShow';
import { hasApiCode } from '../../api/client';
import { RevealChoice } from '../RevealChoice';

type Tap = 'sending' | 'done' | 'late' | 'error';
type Vote = { status: Tap | 'duplicate'; option: ShowChoiceOption | null };

/** Actions live above the personal reveal dialog so moving them into/out of it can't resubmit. */
export function useRevealShowActions({
  reveal,
  eventId,
  myId,
  eligible,
  snapshot,
  now,
}: {
  reveal: RevealViewOutput;
  eventId: string;
  myId: string;
  eligible: boolean;
  snapshot: number;
  now: () => number;
}) {
  const { t } = useTranslation();
  const hasPilot = reveal.lights !== undefined || reveal.choice !== undefined;
  const choice = reveal.choice;
  const open = choice?.status === 'open' ? choice : undefined;
  const giftId = reveal.current?.stage === 'revealed' ? reveal.current.giftId : undefined;
  const privateState = useQuery({
    queryKey: ['my-reveal-show', eventId, myId, snapshot, open?.round],
    queryFn: revealShowApi.mine,
    enabled: hasPilot && eligible && (!!giftId || !!open),
    staleTime: 0,
    retry: 1,
    refetchInterval: (q) =>
      open &&
      now() < Date.parse(open.endsAt) &&
      q.state.data &&
      q.state.data.choice?.round !== open.round
        ? 350
        : false,
  });
  const [lights, setLights] = useState<Record<string, Tap>>({});
  const [votes, setVotes] = useState<Record<number, Vote>>({});
  const pending = useRef(new Set<string>());
  // A prior successful request in this session remains authoritative even if a GET raced it.
  const complete = useRef(new Set<string>());
  const light = async () => {
    if (!giftId || !eligible || !privateState.data || privateState.data.litGiftIds.includes(giftId))
      return;
    const key = `gift:${giftId}`;
    if (pending.current.has(key) || complete.current.has(key)) return;
    pending.current.add(key);
    setLights((s) => ({ ...s, [giftId]: 'sending' }));
    try {
      await revealShowApi.light(giftId);
      complete.current.add(key);
      setLights((s) => ({ ...s, [giftId]: 'done' }));
    } catch (e) {
      const late = hasApiCode(e, 'gift_not_revealed', 'invalid_step');
      if (late) complete.current.add(key);
      setLights((s) => ({ ...s, [giftId]: late ? 'late' : 'error' }));
    } finally {
      pending.current.delete(key);
    }
  };
  const vote = async (option: ShowChoiceOption) => {
    if (
      !open ||
      !eligible ||
      privateState.data?.choice?.round !== open.round ||
      privateState.data.choice.myChoice !== null ||
      now() >= Date.parse(open.endsAt)
    )
      return;
    const { round } = open;
    const key = `round:${round}`;
    if (pending.current.has(key) || complete.current.has(key)) return;
    pending.current.add(key);
    const set = (status: Vote['status'], picked: Vote['option'] = option) =>
      setVotes((s) => ({ ...s, [round]: { status, option: picked } }));
    set('sending');
    try {
      const result = await revealShowApi.vote({ round, choice: option });
      complete.current.add(key);
      set('done', result.choice);
    } catch (e) {
      if (hasApiCode(e, 'already_submitted')) {
        complete.current.add(key);
        // Do not assume the duplicate selected the same option (another tab may have voted).
        set('duplicate', null);
        void privateState.refetch();
      } else {
        const late = hasApiCode(e, 'round_not_open', 'invalid_step');
        if (late) complete.current.add(key);
        set(late ? 'late' : 'error');
      }
    } finally {
      pending.current.delete(key);
    }
  };
  const myRound =
    open && privateState.data?.choice?.round === open.round ? privateState.data.choice : null;
  const localVote = choice ? votes[choice.round] : undefined;
  const duplicate = localVote?.status === 'duplicate';
  const selected = myRound?.myChoice ?? (localVote?.status === 'done' ? localVote.option : null);
  const lit =
    !!giftId && (lights[giftId] === 'done' || !!privateState.data?.litGiftIds.includes(giftId));
  const lightStatus = giftId ? lights[giftId] : undefined;
  const button = 'min-h-12 rounded-xl border-2 px-4 py-2 font-semibold text-ink-900';

  // A failed hydration must not enable an action with unknown private state. Retry quietly.
  const { isError, refetch } = privateState;
  useEffect(() => {
    if (!eligible || !isError) return;
    const timer = setTimeout(() => void refetch(), 3000);
    return () => clearTimeout(timer);
  }, [eligible, isError, refetch, privateState.errorUpdatedAt]);

  if (!hasPilot || (!choice && (!eligible || !giftId || !privateState.data))) return null;
  return (
    <div className="w-full space-y-3 rounded-xl bg-pine-900 p-3 text-white">
      {eligible && giftId && privateState.data && lightStatus !== 'late' && (
        <div className="space-y-1">
          <button
            data-testid="reveal-light"
            type="button"
            aria-disabled={lit || lightStatus === 'sending'}
            onClick={() => void light()}
            className={`${button} w-full border-gold-400 bg-gold-400 text-lg`}
          >
            <span aria-hidden="true">{lit ? '✓ ' : '🎄 '}</span>
            {t('revealShow.tree')}
          </button>
          <p role="status" data-testid="reveal-light-status">
            {lit ? t('revealShow.lit') : lightStatus === 'sending' ? t('revealShow.lighting') : ''}
          </p>
          {lightStatus === 'error' && <p role="alert">{t('revealShow.retry')}</p>}
        </div>
      )}
      {!giftId || lightStatus !== 'late' ? null : (
        <p role="status">{t('revealShow.notEligible')}</p>
      )}
      {choice && (
        <div className="space-y-2">
          <RevealChoice choice={choice} now={now}>
            {(left) =>
              eligible &&
              left > 0 &&
              (myRound || localVote) &&
              localVote?.status !== 'late' && (
                <div
                  className="grid grid-cols-2 gap-2"
                  role="group"
                  aria-label={t('revealShow.matchup')}
                >
                  {SHOW_CHOICE_OPTIONS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={selected === option}
                      aria-disabled={!!selected || duplicate || localVote?.status === 'sending'}
                      className={`${button} border-white bg-white aria-pressed:border-gold-400 aria-pressed:bg-gold-400`}
                      onClick={() => void vote(option)}
                    >
                      <span aria-hidden="true">{option === 'snowstorm' ? '❄️ ' : '🔔 '}</span>
                      {t(`revealShow.option.${option}`)}
                    </button>
                  ))}
                </div>
              )
            }
          </RevealChoice>
          <p role="status" data-testid="reveal-choice-feedback" className="empty:sr-only">
            {selected
              ? t('revealShow.voted')
              : duplicate
                ? t('revealShow.alreadyVoted')
                : localVote?.status === 'sending'
                  ? t('revealShow.sendingVote')
                  : localVote?.status === 'late'
                    ? t('revealShow.tooLate')
                    : ''}
          </p>
          {open && localVote?.status === 'error' && <p role="alert">{t('revealShow.retry')}</p>}
        </div>
      )}
    </div>
  );
}
