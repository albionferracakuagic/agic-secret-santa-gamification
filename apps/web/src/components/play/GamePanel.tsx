import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SceneOutput } from '@santa/contracts';
import { usePhase2Api, type MyGame } from '../../api/phase2';
import { Countdown } from '../Countdown';
import { useLocalized } from '../../lib/localized';
import { emitFx } from '../../fx/bus';
import { errorKey } from '../../pages/Dashboard';

type Game = NonNullable<MyGame['game']>;
type Me = NonNullable<MyGame['me']>;

const opt =
  'min-h-14 w-full rounded border-2 border-pine-900 bg-white px-4 text-left text-lg font-semibold aria-pressed:bg-pine-900 aria-pressed:text-white disabled:opacity-60';

/** Re-renders on a short interval so "get ready" flips to "tap now" on the server clock without a push. */
function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** FR-031/032: the active mini-game as the participant sees it (public view + own state only; timers use server time). */
export function GamePanel({ scene, now }: { scene: SceneOutput | undefined; now: () => number }) {
  const { t } = useTranslation();
  const api = usePhase2Api();
  const qc = useQueryClient();
  const live = scene?.scene === 'game';
  const q = useQuery({
    queryKey: ['my-game'],
    queryFn: () => api.myGame(),
    refetchInterval: live ? 5000 : false,
  });
  const sig =
    scene?.scene === 'game'
      ? `${scene.game.gameId}|${scene.game.status}|${scene.game.round?.index}`
      : 'none';
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ['my-game'] });
  }, [sig, qc]);
  const game = q.data?.game;
  const me = q.data?.me ?? null;
  if (!game) return null;
  return (
    <section aria-labelledby="game-title" className="space-y-3" data-testid="game-panel">
      <h2 id="game-title" className="text-xl font-semibold">
        {t(`game.kind.${game.kind}`)}
      </h2>
      <GameBody game={game} me={me} now={now} onChange={() => void q.refetch()} />
    </section>
  );
}

function GameBody({
  game,
  me,
  now,
  onChange,
}: {
  game: Game;
  me: Me | null;
  now: () => number;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  const loc = useLocalized();
  const round = game.round;
  const lastKey = me?.lastRound ? `${round?.index}|${me.lastRound.outcome}` : '';
  useEffect(() => {
    if (!me?.lastRound) return;
    if (me.lastRound.outcome === 'correct') emitFx('correct_guess');
    else if (me.lastRound.outcome === 'incorrect') emitFx('guess_wink');
  }, [lastKey]);
  return (
    <>
      <p role="status">{t(`game.status.${game.status}`)}</p>
      {game.status === 'intro' && (
        <>
          <p>{loc(game.rules)}</p>
          {game.stepEndsAt && <Countdown endsAt={game.stepEndsAt} now={now} className="text-4xl" />}
        </>
      )}
      {round && game.status !== 'intro' && (
        <div className="space-y-3">
          <p className="font-semibold">
            {t('game.round', { n: round.index + 1, total: round.total })}
          </p>
          <p className="text-lg">{loc(round.prompt)}</p>
          {game.status === 'round_open' && round.endsAt && (
            <Countdown endsAt={round.endsAt} now={now} className="text-3xl" />
          )}
          {game.status === 'round_open' && game.kind === 'bingo' && me?.card && (
            <BingoCard card={me.card} onChange={onChange} />
          )}
          {game.status === 'round_open' && game.kind === 'speed' && (
            <TapButton game={game} me={me} now={now} onChange={onChange} />
          )}
          {game.kind !== 'speed' && game.kind !== 'bingo' && (
            <Options game={game} me={me} now={now} onChange={onChange} />
          )}
          {game.status === 'round_open' && (
            <p>{t('game.answeredCount', { n: round.submissionCount })}</p>
          )}
        </div>
      )}
      {game.kind === 'bingo' && game.status !== 'round_open' && me?.card && (
        <BingoCard card={me.card} readOnly onChange={onChange} />
      )}
      {game.status === 'round_closed' && me?.lastRound && (
        <p
          role="status"
          className="rounded bg-gold-400 p-3 font-semibold text-ink-900"
          data-testid="round-feedback"
        >
          {me.lastRound.outcome === 'correct' && (
            <>🎉 {t('game.correct', { points: me.lastRound.points })}</>
          )}
          {me.lastRound.outcome === 'incorrect' && <>😉 {t('game.incorrect')}</>}
          {me.lastRound.outcome === 'none' && t('game.none_')}
        </p>
      )}
      {me && <p>{t('game.score', { n: me.score })}</p>}
      {game.status === 'results' && game.results && <Winners results={game.results} />}
    </>
  );
}

function Options({
  game,
  me,
  now,
  onChange,
}: {
  game: Game;
  me: Me | null;
  now: () => number;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  const api = usePhase2Api();
  const loc = useLocalized();
  const round = game.round!;
  const send = useMutation({
    mutationFn: (id: string) => api.submitAnswer(id),
    onSuccess: onChange,
  });
  const open = game.status === 'round_open' && (!round.endsAt || Date.parse(round.endsAt) > now());
  const done = !!me?.submitted;
  const correct = round.correctOptionIds;
  if (round.options.length === 0) return null;
  return (
    <div className="space-y-2">
      <ul className="space-y-2" aria-label={t('game.title')}>
        {round.options.map((o) => (
          <li key={o.id}>
            <button
              type="button"
              className={opt}
              aria-pressed={me?.answerId === o.id}
              disabled={!open || done || send.isPending}
              onClick={() => send.mutate(o.id)}
            >
              {loc(o.label)}
              {correct?.includes(o.id) && <span> ✅</span>}
            </button>
          </li>
        ))}
      </ul>
      <p role="status">
        {done ? t('game.answered') : ''}
        {send.isError ? t(errorKey(send.error)) : ''}
      </p>
    </div>
  );
}

function TapButton({
  game,
  me,
  now,
  onChange,
}: {
  game: Game;
  me: Me | null;
  now: () => number;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  const api = usePhase2Api();
  useTick(250);
  const send = useMutation({ mutationFn: () => api.submitAnswer('tap'), onSuccess: onChange });
  const go = !game.round?.opensAt || Date.parse(game.round.opensAt) <= now();
  const done = !!me?.submitted;
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="min-h-32 w-full rounded-2xl bg-gold-400 text-3xl font-extrabold text-ink-900 disabled:opacity-60"
        disabled={!go || done || send.isPending}
        onClick={() => send.mutate()}
      >
        {go ? `⭐ ${t('game.tap')}` : t('game.getReady')}
      </button>
      <p role="status">{done ? t('game.answered') : ''}</p>
    </div>
  );
}

function BingoCard({
  card,
  readOnly = false,
  onChange,
}: {
  card: NonNullable<Me['card']>;
  readOnly?: boolean;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  const api = usePhase2Api();
  const loc = useLocalized();
  const mark = useMutation({
    mutationFn: (cell: number) => api.markBingo(cell),
    onSuccess: onChange,
  });
  return (
    <div className="space-y-2">
      <h3 className="font-semibold">{t('game.bingo')}</h3>
      <ul className="grid grid-cols-5 gap-1" data-testid="bingo-card">
        {card.cells.map((c) => {
          const label = c.free ? t('game.free') : loc(c.label);
          return (
            <li key={c.cell}>
              <button
                type="button"
                aria-pressed={c.mark !== 'none' || c.free}
                aria-label={`${t('game.mark', { label })} — ${t(`game.cell.${c.mark}`)}`}
                disabled={readOnly || c.free || c.mark !== 'none' || mark.isPending}
                className="min-h-14 w-full rounded border border-ink-900/40 bg-white p-1 text-xs aria-pressed:bg-gold-400 aria-pressed:font-bold"
                onClick={() => mark.mutate(c.cell)}
              >
                {label}
                {c.mark === 'pending' && <span aria-hidden="true"> ⏳</span>}
                {(c.mark === 'confirmed' || c.free) && <span aria-hidden="true"> ✓</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <p>{t('game.lines', { n: card.lines })}</p>
    </div>
  );
}

/** Published top-N only (no scores, no totals); `christmas_magic` is the neutral fallback. */
export function Winners({
  results,
  big = false,
}: {
  results: NonNullable<Game['results']>;
  big?: boolean;
}) {
  const { t } = useTranslation();
  if (results.message || results.entries.length === 0)
    return <p className={big ? 'text-6xl' : 'font-semibold'}>✨ {t('game.magic')}</p>;
  return (
    <div className="space-y-2">
      <h3 className={big ? 'text-5xl font-bold' : 'font-semibold'}>{t('game.winners')}</h3>
      <ol className={big ? 'space-y-4 text-6xl' : 'space-y-1'} data-testid="game-winners">
        {results.entries.map((e) => (
          <li key={e.person.participantId}>
            🏆 {e.person.displayName}
            {e.tied && ` (${t('game.tied')})`}
          </li>
        ))}
      </ol>
    </div>
  );
}
