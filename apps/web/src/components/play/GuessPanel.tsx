import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CLUE_MAX_LENGTH, CLUE_MIN_LENGTH } from '@santa/contracts';
import { usePhase2Api, type GuessState } from '../../api/phase2';
import { errorKey } from '../../pages/Dashboard';

const btn = 'min-h-12 rounded bg-pine-900 px-4 font-semibold text-white disabled:opacity-50';

/** FR-025: guess screen (own data only). Hidden entirely while `features.guessSanta` is off (`enabled: false`). */
export function GuessPanel({ selfId }: { selfId: string }) {
  const { t } = useTranslation();
  const api = usePhase2Api();
  const q = useQuery({ queryKey: ['guess'], queryFn: () => api.guessState() });
  const s = q.data;
  if (!s?.enabled) return null;
  const suspects = s.suspects
    .filter((p) => p.participantId !== selfId)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return (
    <section aria-labelledby="guess-title" className="space-y-4" data-testid="guess-panel">
      <h2 id="guess-title" className="text-xl font-semibold">
        {t('guess.title')}
      </h2>
      <p>{t('guess.intro')}</p>
      {s.gifts.length === 0 && <p>{t('guess.noGifts')}</p>}
      <ul className="space-y-4">
        {s.gifts.map((g) => (
          <GiftGuess key={g.giftId} gift={g} suspects={suspects} />
        ))}
      </ul>
      <ClueSection />
    </section>
  );
}

type Gift = GuessState['gifts'][number];

function GiftGuess({ gift, suspects }: { gift: Gift; suspects: GuessState['suspects'] }) {
  const { t } = useTranslation();
  const api = usePhase2Api();
  const qc = useQueryClient();
  const [pick, setPick] = useState(gift.myGuess ?? '');
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => api.setGuess(gift.giftId, pick),
    onSuccess: () => {
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['guess'] });
    },
  });
  const selectId = `guess-${gift.giftId}`;
  const nameOf = (id: string | null) => suspects.find((p) => p.participantId === id)?.displayName;
  return (
    <li className="space-y-2 rounded border border-ink-900/30 bg-white p-3">
      <h3 className="font-semibold">🎁 {gift.alias}</h3>
      {gift.state === 'own' && <p>{t('guess.own')}</p>}
      {gift.state === 'guessable' && (
        <div className="flex flex-wrap items-end gap-2">
          <label htmlFor={selectId} className="block grow">
            {t('guess.suspect', { alias: gift.alias })}
            <select
              id={selectId}
              className="mt-1 block min-h-12 w-full rounded border border-ink-900/40 bg-white px-3"
              value={pick}
              onChange={(e) => {
                setPick(e.target.value);
                setSaved(false);
              }}
            >
              <option value="">{t('guess.choose')}</option>
              {suspects.map((p) => (
                <option key={p.participantId} value={p.participantId}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={btn}
            disabled={!pick || save.isPending || pick === gift.myGuess}
            onClick={() => save.mutate()}
          >
            {t('guess.save')}
          </button>
        </div>
      )}
      {gift.state === 'revealed' && (
        <>
          <p>{t('guess.revealed')}</p>
          {gift.myGuess && <p>{nameOf(gift.myGuess)}</p>}
          {gift.result && <GuessResult result={gift.result} />}
        </>
      )}
      <p role="status">
        {saved ? t('guess.saved') : ''}
        {save.isError ? t(errorKey(save.error)) : ''}
      </p>
      {gift.clues.length > 0 && (
        <ul className="list-disc pl-5" aria-label={t('guess.cluesTitle')}>
          {gift.clues.map((c) => (
            <li key={c.clueId}>💡 {c.text}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Positive-only: a correct guess earns confetti, an incorrect one a friendly wink (FR-046: no failure cue). */
export function GuessResult({ result }: { result: NonNullable<Gift['result']> }) {
  const { t } = useTranslation();
  return (
    <p
      role="status"
      data-testid="guess-result"
      data-cue={result.cue}
      className="rounded bg-gold-400 p-3 font-semibold text-ink-900"
    >
      <span aria-hidden="true">{result.outcome === 'correct' ? '🎉' : '😉'}</span>{' '}
      {result.outcome === 'correct' ? t('guess.correct', { xp: result.xp }) : t('guess.incorrect')}
    </p>
  );
}

function ClueSection() {
  const { t } = useTranslation();
  const api = usePhase2Api();
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: ['my-clues'], queryFn: () => api.myClues() });
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const send = useMutation({
    mutationFn: (v: string) => api.submitClue(v),
    onSuccess: () => {
      setText('');
      setSent(true);
      void qc.invalidateQueries({ queryKey: ['my-clues'] });
    },
  });
  const trimmed = text.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSent(false);
    send.mutate(trimmed);
  };
  return (
    <div className="space-y-2">
      <form onSubmit={submit} className="space-y-2">
        <label className="block">
          {t('guess.clueLabel')}
          <textarea
            className="mt-1 block min-h-24 w-full rounded border border-ink-900/40 bg-white p-3"
            value={text}
            maxLength={CLUE_MAX_LENGTH}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button className={btn} disabled={trimmed.length < CLUE_MIN_LENGTH || send.isPending}>
          {t('guess.sendClue')}
        </button>
        <p role="status">
          {sent ? t('guess.clueSent') : ''}
          {send.isError ? t(errorKey(send.error)) : ''}
        </p>
      </form>
      {(mine.data?.clues.length ?? 0) > 0 && (
        <>
          <h3 className="font-semibold">{t('guess.myClues')}</h3>
          <ul className="list-disc pl-5" data-testid="my-clues">
            {mine.data?.clues.map((c) => (
              <li key={c.clueId}>
                {c.text} — {t(`guess.clueStatus.${c.status}`)}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
