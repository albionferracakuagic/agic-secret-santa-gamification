import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GAME_KINDS, SPOTLIGHT_KINDS, type GameKind, type SpotlightKind } from '@santa/contracts';
import { usePhase2Api, type GameAction, type PresentResult } from '../../api/phase2';
import { useLocalized } from '../../lib/localized';
import { errorKey } from '../../pages/Dashboard';

const btn = 'min-h-12 rounded border border-ink-900 px-4 font-semibold disabled:opacity-50';
const primary = 'min-h-12 rounded bg-pine-900 px-4 font-semibold text-white disabled:opacity-50';
const field = 'mt-1 block min-h-12 w-full rounded border border-ink-900/40 bg-white px-3';

const Err = ({ e }: { e: unknown }) => {
  const { t } = useTranslation();
  return e ? (
    <p role="alert" className="rounded bg-santa-700 p-3 text-white">
      {t(errorKey(e))}
    </p>
  ) : null;
};

/** Organizer clue moderation queue (masked: gift alias + text only, never the author). */
export function ClueQueue({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const api = usePhase2Api();
  const qc = useQueryClient();
  const key = ['clue-queue', eventId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.clueQueue(eventId),
    refetchInterval: 10_000,
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; action: 'approve' | 'reject' }) =>
      api.decideClue(eventId, v.id, v.action),
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const pending = q.data?.clues.filter((c) => c.status === 'pending') ?? [];
  if (q.data && !q.data.enabled) return null;
  return (
    <section aria-labelledby="clue-q-title" className="space-y-2" data-testid="clue-queue">
      <h2 id="clue-q-title" className="text-xl font-semibold">
        {t('guessCtl.queueTitle')}
      </h2>
      {pending.length === 0 ? (
        <p>{t('guessCtl.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {pending.map((c) => (
            <li key={c.clueId} className="space-y-2 rounded border border-ink-900/30 bg-white p-3">
              <p>
                <strong>{c.alias}</strong>: {c.text}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={primary}
                  disabled={decide.isPending}
                  aria-label={`${t('guessCtl.approve')} ${c.alias}`}
                  onClick={() => decide.mutate({ id: c.clueId, action: 'approve' })}
                >
                  {t('guessCtl.approve')}
                </button>
                <button
                  type="button"
                  className={btn}
                  disabled={decide.isPending}
                  aria-label={`${t('guessCtl.reject')} ${c.alias}`}
                  onClick={() => decide.mutate({ id: c.clueId, action: 'reject' })}
                >
                  {t('guessCtl.reject')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Err e={decide.error} />
    </section>
  );
}

/** Presentations: show a canPublish-gated board on the display (the reason a publish failed is organizer-only). */
export function PresentationControls({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const api = usePhase2Api();
  const [result, setResult] = useState<PresentResult>();
  const present = useMutation({
    mutationFn: (k: SpotlightKind) => api.present(eventId, k),
    onSuccess: setResult,
  });
  const hide = useMutation({
    mutationFn: () => api.hideSpotlight(eventId),
    onSuccess: () => setResult(undefined),
  });
  return (
    <section aria-labelledby="present-title" className="space-y-2">
      <h2 id="present-title" className="text-xl font-semibold">
        {t('guessCtl.presentTitle')}
      </h2>
      <div className="flex flex-wrap gap-2">
        {SPOTLIGHT_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className={btn}
            disabled={present.isPending}
            onClick={() => present.mutate(k)}
          >
            {t('guessCtl.show')}: {t(`guessCtl.kind.${k}`)}
          </button>
        ))}
        <button
          type="button"
          className={btn}
          disabled={hide.isPending}
          onClick={() => hide.mutate()}
        >
          {t('guessCtl.hide')}
        </button>
      </div>
      {result && (
        <p role="status">
          {result.published
            ? t('guessCtl.shown')
            : t('guessCtl.notShown', {
                reason: result.reason ? t(`guessCtl.reason.${result.reason}`) : '-',
              })}
        </p>
      )}
      <Err e={present.error ?? hide.error} />
    </section>
  );
}

/** Missions console: assign, counts, verify/reject/reassign. Hidden while `features.missions` is off. */
export function MissionsConsole({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const api = usePhase2Api();
  const loc = useLocalized();
  const qc = useQueryClient();
  const key = ['org-missions', eventId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.organizerMissions(eventId),
    refetchInterval: 10_000,
  });
  const [assigned, setAssigned] = useState<number>();
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const assign = useMutation({
    mutationFn: () => api.assignMissions(eventId),
    onSuccess: (r) => {
      setAssigned(r.assigned);
      refresh();
    },
  });
  const verify = useMutation({
    mutationFn: (v: { id: string; action: 'verify' | 'reject' | 'reassign' }) =>
      api.verifyMission(eventId, v.id, v.action),
    onSettled: refresh,
  });
  const s = q.data;
  if (!s?.enabled) return null;
  return (
    <section
      aria-labelledby="missions-ctl-title"
      className="space-y-2"
      data-testid="missions-console"
    >
      <h2 id="missions-ctl-title" className="text-xl font-semibold">
        {t('missionsCtl.title')}
      </h2>
      <p>{t('missionsCtl.counts', s.counts)}</p>
      <button
        type="button"
        className={primary}
        disabled={assign.isPending}
        onClick={() => assign.mutate()}
      >
        {t('missionsCtl.assign')}
      </button>
      {assigned !== undefined && <p role="status">{t('missionsCtl.assigned', { n: assigned })}</p>}
      {s.verification === 'organizer' && (
        <>
          <h3 className="font-semibold">{t('missionsCtl.pending')}</h3>
          {s.pending.length === 0 ? (
            <p>{t('missionsCtl.none')}</p>
          ) : (
            <ul className="space-y-2">
              {s.pending.map((p) => (
                <li
                  key={p.assignmentId}
                  className="space-y-2 rounded border border-ink-900/30 bg-white p-3"
                >
                  <p>
                    <strong>{p.displayName}</strong>: {loc(p.title)}
                    {p.note && <> — {p.note}</>}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(['verify', 'reject', 'reassign'] as const).map((a) => (
                      <button
                        key={a}
                        type="button"
                        className={a === 'verify' ? primary : btn}
                        disabled={verify.isPending}
                        aria-label={`${t(`missionsCtl.${a}`)} ${p.displayName}`}
                        onClick={() => verify.mutate({ id: p.assignmentId, action: a })}
                      >
                        {t(`missionsCtl.${a}`)}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <Err e={assign.error ?? verify.error} />
    </section>
  );
}

const ACTIONS: Record<string, GameAction[]> = {
  draft: ['start', 'cancel'],
  intro: ['next', 'show_results', 'cancel'],
  round_open: ['next', 'show_results', 'cancel'],
  round_closed: ['next', 'show_results', 'cancel'],
  results: ['finish', 'cancel'],
};

/** Games console: create/configure, drive the game, confirm bingo marks. */
export function GamesConsole({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const api = usePhase2Api();
  const loc = useLocalized();
  const qc = useQueryClient();
  const key = ['org-games', eventId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.organizerGames(eventId),
    refetchInterval: 5000,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['bingo-marks', eventId] });
  };
  const act = useMutation({
    mutationFn: (v: { id: string; action: GameAction }) => api.gameAction(eventId, v.id, v.action),
    onSettled: refresh,
  });
  const [kind, setKind] = useState<GameKind>('trivia');
  const [title, setTitle] = useState('');
  const [rounds, setRounds] = useState(5);
  const [roundSeconds, setRoundSeconds] = useState(20);
  const [revealSeconds, setRevealSeconds] = useState(6);
  const [introSeconds, setIntroSeconds] = useState(5);
  const create = useMutation({
    mutationFn: () =>
      api.createGame(eventId, {
        kind,
        ...(title.trim() ? { title: { en: title.trim() } } : {}),
        config: { rounds, roundSeconds, revealSeconds, introSeconds },
      }),
    onSuccess: () => {
      setTitle('');
      refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  if (q.data && !q.data.enabled) return null;
  const num = (label: string, v: number, set: (n: number) => void, min: number, max: number) => (
    <label className="block">
      {label}
      <input
        type="number"
        className={field}
        min={min}
        max={max}
        value={v}
        onChange={(e) => set(Number(e.target.value))}
      />
    </label>
  );
  return (
    <section aria-labelledby="games-ctl-title" className="space-y-3" data-testid="games-console">
      <h2 id="games-ctl-title" className="text-xl font-semibold">
        {t('gamesCtl.title')}
      </h2>
      {q.data && (
        <p className="text-sm">
          {t('gamesCtl.catalog', {
            trivia: q.data.catalog.triviaQuestions,
            bingo: q.data.catalog.bingoSquares,
          })}
        </p>
      )}
      {q.data?.canCreate && (
        <form onSubmit={submit} className="space-y-2">
          <label className="block">
            {t('gamesCtl.kind')}
            <select
              className={field}
              value={kind}
              onChange={(e) => setKind(e.target.value as GameKind)}
            >
              {GAME_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`game.kind.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            {t('gamesCtl.gameTitle')}
            <input
              className={field}
              value={title}
              maxLength={80}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          {num(t('gamesCtl.rounds'), rounds, setRounds, 1, 20)}
          {num(t('gamesCtl.roundSeconds'), roundSeconds, setRoundSeconds, 5, 1800)}
          {num(t('gamesCtl.revealSeconds'), revealSeconds, setRevealSeconds, 0, 60)}
          {num(t('gamesCtl.introSeconds'), introSeconds, setIntroSeconds, 0, 60)}
          <button className={primary} disabled={create.isPending}>
            {t('gamesCtl.create')}
          </button>
        </form>
      )}
      {q.data?.games.length === 0 && <p>{t('gamesCtl.empty')}</p>}
      <ul className="space-y-3">
        {q.data?.games.map((g) => (
          <li key={g.gameId} className="space-y-2 rounded border border-ink-900/30 bg-white p-3">
            <p className="font-semibold">
              {t(`game.kind.${g.kind}`)} — {loc(g.title)}
            </p>
            <p role="status">
              {t(`gamesCtl.status.${g.status}`)}
              {g.roundIndex >= 0 && g.totalRounds > 0 && (
                <> · {t('gamesCtl.roundOf', { n: g.roundIndex + 1, total: g.totalRounds })}</>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              {(ACTIONS[g.status] ?? []).map((a) => (
                <button
                  key={a}
                  type="button"
                  className={a === 'cancel' ? btn : primary}
                  disabled={act.isPending}
                  aria-label={`${t(`gamesCtl.action.${a}`)}: ${loc(g.title)}`}
                  onClick={() => act.mutate({ id: g.gameId, action: a })}
                >
                  {t(`gamesCtl.action.${a}`)}
                </button>
              ))}
            </div>
            {g.kind === 'bingo' &&
              g.status !== 'draft' &&
              g.status !== 'finished' &&
              g.status !== 'cancelled' && <BingoQueue eventId={eventId} gameId={g.gameId} />}
          </li>
        ))}
      </ul>
      <Err e={act.error ?? create.error} />
    </section>
  );
}

function BingoQueue({ eventId, gameId }: { eventId: string; gameId: string }) {
  const { t } = useTranslation();
  const api = usePhase2Api();
  const loc = useLocalized();
  const qc = useQueryClient();
  const key = ['bingo-marks', eventId, gameId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.bingoPending(eventId, gameId),
    refetchInterval: 3000,
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; action: 'confirm' | 'reject' }) =>
      api.decideBingo(eventId, gameId, v.id, v.action),
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const marks = q.data?.marks ?? [];
  return (
    <div className="space-y-2" data-testid="bingo-queue">
      <h3 className="font-semibold">{t('gamesCtl.bingoTitle')}</h3>
      {marks.length === 0 ? (
        <p>{t('gamesCtl.bingoEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {marks.map((m) => (
            <li key={m.markId} className="flex flex-wrap items-center gap-2">
              <span className="grow">
                {m.displayName}: {loc(m.label)}
              </span>
              <button
                type="button"
                className={primary}
                disabled={decide.isPending}
                aria-label={`${t('gamesCtl.confirm')} ${m.displayName}: ${loc(m.label)}`}
                onClick={() => decide.mutate({ id: m.markId, action: 'confirm' })}
              >
                {t('gamesCtl.confirm')}
              </button>
              <button
                type="button"
                className={btn}
                disabled={decide.isPending}
                aria-label={`${t('gamesCtl.reject')} ${m.displayName}: ${loc(m.label)}`}
                onClick={() => decide.mutate({ id: m.markId, action: 'reject' })}
              >
                {t('gamesCtl.reject')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Err e={decide.error} />
    </div>
  );
}
