import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useParticipantApi } from '../api/participant';
import { avatarGlyph } from '../fx/avatars';
import { floatReaction } from '../fx/reactions';
import type {
  EventStateOutput,
  PublicGiftListOutput,
  PublicLeaderboardOutput,
} from '@santa/contracts';
import { surfaceOf, useRealtime } from '../realtime/react';
import { Qr } from '../components/Qr';
import { emitFx } from '../fx/bus';
import { isAudioUnlocked, unlockAudio } from '../fx/audio';
import { usePrefs } from '../prefs/store';

type DState = Extract<EventStateOutput, { role: 'display' }>;
type Announcement = { displayName: string; avatar: string | null; achievement: string };

const STAGE_W = 1920;
const STAGE_H = 1080;

/** Fit the fixed 1080p stage to any viewport (letterboxed, never cropped). */
function useStageScale() {
  const calc = () => Math.min(innerWidth / STAGE_W, innerHeight / STAGE_H);
  const [s, setS] = useState(calc);
  useEffect(() => {
    const on = () => setS(calc());
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, []);
  return s;
}

/** Fires cues only on changes after the first snapshot, never on initial load. */
function usePrevEffect<T>(v: T | undefined, fn: (prev: T, next: T | undefined) => void) {
  const prev = useRef<T | undefined>(undefined);
  const first = useRef(true);
  useEffect(() => {
    if (!first.current && prev.current !== undefined) fn(prev.current, v);
    first.current = false;
    prev.current = v;
  }, [v]);
}

const asAnnouncement = (x: unknown): Announcement | undefined => {
  const a = x as Partial<Announcement> | undefined;
  return a && typeof a.displayName === 'string' && typeof a.achievement === 'string'
    ? { displayName: a.displayName, avatar: a.avatar ?? null, achievement: a.achievement }
    : undefined;
};

/** /d[/<token>] — exchanges the display token for its cookie first, and only then opens the realtime stream. */
export default function Display() {
  const api = useParticipantApi();
  const nav = useNavigate();
  const token = useParams()['*']?.split('/')[0];
  useEffect(() => {
    if (!token) return;
    void api.exchangeDisplayToken(token).finally(() => nav('/d', { replace: true }));
  }, [token, api, nav]);
  return token ? null : <DisplayStage />;
}

/** Renders only what the display projection sent; join link/code come from the display URL. */
function DisplayStage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const { rt, state } = useRealtime();
  const es = surfaceOf<DState>(state, 'pub', 'eventState');
  const gifts = surfaceOf<PublicGiftListOutput>(state, 'pub', 'giftList');
  const board = surfaceOf<PublicLeaderboardOutput>(state, 'pub', 'leaderboard');
  const announcement = asAnnouncement(state.surfaces['pub']?.['announcement']);
  const endsAt = state.surfaces['pub']?.['votingEndsAt'];
  const scale = useStageScale();

  usePrevEffect(
    es?.counts.participants,
    (p, n) => n !== undefined && p < n && emitFx('participant_joined'),
  );
  usePrevEffect(
    es?.counts.giftsRegistered,
    (p, n) => n !== undefined && p < n && emitFx('gift_registered'),
  );
  usePrevEffect(es?.votedCount, (p, n) => n !== undefined && p < n && emitFx('vote_submitted'));
  usePrevEffect(es?.phase, (_p, n) => {
    if (n === 'voting') emitFx('voting_started');
    if (n === 'awards') emitFx('grand_winner');
  });
  usePrevEffect(
    es && (board?.entries[0]?.entryId ?? ''),
    (_p, n) => n && emitFx('leaderboard_entry'),
  );
  usePrevEffect(
    es && (announcement ? announcement.displayName + '|' + announcement.achievement : ''),
    (_p, n) => n && emitFx('achievement_earned'),
  );
  usePrevEffect(state.reactions.at(-1)?.seq ?? 0, () => {
    const last = state.reactions.at(-1);
    if (last) floatReaction(last.kind);
  });

  const joinUrl = params.get('join') ?? `${location.origin}/j`;
  const shortCode = params.get('code');

  return (
    <div
      className="fixed inset-0 overflow-hidden bg-pine-900 text-white"
      data-testid="display-root"
    >
      <h1 className="sr-only">{t('route.display')}</h1>
      <div
        className="absolute left-1/2 top-1/2"
        style={{
          width: STAGE_W,
          height: STAGE_H,
          transform: `translate(-50%,-50%) scale(${scale})`,
        }}
        data-testid="display-stage"
      >
        {!es ? (
          <Scene title={t('display.waiting')} />
        ) : announcement ? (
          <AchievementScene a={announcement} />
        ) : es.phase === 'voting' ? (
          <VotingScene
            es={es}
            endsAt={typeof endsAt === 'string' ? endsAt : undefined}
            now={() => rt?.serverNow() ?? Date.now()}
          />
        ) : es.phase === 'gift_registration' ? (
          <RegistrationScene es={es} />
        ) : es.phase === 'gift_opening' ? (
          <GiftOpeningScene es={es} gifts={gifts} />
        ) : es.phase === 'reveal' ||
          es.phase === 'awards' ||
          es.phase === 'completed' ||
          es.phase === 'games' ? (
          <BoardScene board={board} gifts={gifts} />
        ) : (
          <LobbyScene es={es} joinUrl={joinUrl} code={shortCode} />
        )}
      </div>
      <SoundUnlock />
    </div>
  );
}

function Scene({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section
      aria-label={title}
      className="flex h-full w-full flex-col items-center justify-center gap-10 p-24 text-center"
    >
      <h2 className="text-8xl font-bold">{title}</h2>
      {children}
    </section>
  );
}

const Big = ({ n, label }: { n: number; label: string }) => (
  <p className="text-5xl">
    <span className="mr-4 text-9xl font-extrabold text-gold-400" data-testid="big-count">
      {n}
    </span>
    {label}
  </p>
);

function LobbyScene({ es, joinUrl, code }: { es: DState; joinUrl: string; code: string | null }) {
  const { t } = useTranslation();
  return (
    <Scene title={t('display.welcome', { event: es.name })}>
      <div className="flex items-center gap-24">
        <div className="h-[420px] w-[420px] rounded-2xl bg-white p-4 text-ink-900">
          <Qr value={joinUrl} label={t('display.qrLabel')} />
        </div>
        <div className="space-y-6 text-left">
          <p className="text-4xl">{t('display.scanToJoin')}</p>
          {code && <p className="text-7xl font-bold tracking-widest">{code}</p>}
          <Big n={es.counts.participants} label={t('display.joined')} />
        </div>
      </div>
    </Scene>
  );
}

function RegistrationScene({ es }: { es: DState }) {
  const { t } = useTranslation();
  return (
    <Scene title={t('display.registrationTitle')}>
      <Big n={es.counts.giftsRegistered} label={t('display.giftsRegistered')} />
      <p className="text-4xl">{t('display.outOf', { n: es.counts.participants })}</p>
    </Scene>
  );
}

function GiftOpeningScene({ es, gifts }: { es: DState; gifts: PublicGiftListOutput | undefined }) {
  const { t } = useTranslation();
  const opened = gifts?.mode === 'gallery' ? gifts.gifts : undefined;
  return (
    <Scene title={t('display.openingTitle')}>
      {opened ? (
        <ul className="flex max-w-[1600px] flex-wrap justify-center gap-8 text-4xl">
          {opened.map((g) => (
            <li key={g.giftId} className="rounded-2xl bg-white/15 px-8 py-4">
              🎁 {g.name}
            </li>
          ))}
        </ul>
      ) : (
        <Big
          n={gifts?.mode === 'count_only' ? gifts.count : es.counts.giftsRegistered}
          label={t('display.giftsOpened')}
        />
      )}
    </Scene>
  );
}

function VotingScene({
  es,
  endsAt,
  now,
}: {
  es: DState;
  endsAt: string | undefined;
  now: () => number;
}) {
  const { t } = useTranslation();
  return (
    <Scene title={t('display.votingTitle')}>
      {endsAt && <Countdown endsAt={endsAt} now={now} />}
      {es.votedCount !== undefined && <Big n={es.votedCount} label={t('display.voted')} />}
    </Scene>
  );
}

export function Countdown({ endsAt, now }: { endsAt: string; now: () => number }) {
  const { t } = useTranslation();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const left = Math.max(0, Math.ceil((Date.parse(endsAt) - now()) / 1000));
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  return (
    <p
      role="timer"
      aria-label={t('display.countdown')}
      className="text-[12rem] font-extrabold leading-none tabular-nums"
    >
      {mm}:{ss}
    </p>
  );
}

const MEDAL = ['👑', '✨', '✨'];

function BoardScene({
  board,
  gifts,
}: {
  board: PublicLeaderboardOutput | undefined;
  gifts: PublicGiftListOutput | undefined;
}) {
  const { t } = useTranslation();
  const entries = board && board.state !== 'hidden' ? board.entries : [];
  const nameOf = (id: string, rank: number) =>
    (gifts?.mode === 'gallery' && gifts.gifts.find((g) => g.giftId === id)?.name) ||
    t('display.entry', { rank });
  return (
    <Scene title={t('display.boardTitle')}>
      {entries.length === 0 ? (
        <p className="text-4xl">{t('display.boardSoon')}</p>
      ) : (
        <ol className="flex items-end gap-10" data-testid="podium">
          {entries.map((e) => (
            <li
              key={e.entryId}
              className="flex w-[360px] flex-col items-center justify-end rounded-t-3xl bg-white/15 px-6 py-8"
              style={{ minHeight: `${Math.max(180, 460 - e.rank * 70)}px` }}
            >
              <span aria-hidden="true" className="text-7xl">
                {MEDAL[e.rank - 1] ?? '⭐'}
              </span>
              <span className="text-5xl font-bold">#{e.rank}</span>
              <span className="text-4xl">{nameOf(e.entryId, e.rank)}</span>
              {e.tied && <span className="text-2xl">{t('display.tied')}</span>}
            </li>
          ))}
        </ol>
      )}
    </Scene>
  );
}

function AchievementScene({ a }: { a: Announcement }) {
  const { t } = useTranslation();
  return (
    <Scene title={t('display.achievementTitle')}>
      <p className="text-9xl" aria-hidden="true">
        {a.avatar ? avatarGlyph(a.avatar) : '🏅'}
      </p>
      <p role="status" className="text-6xl">
        {t('display.achievementLine', {
          name: a.displayName,
          achievement: t(`achievement.${a.achievement}`, { defaultValue: a.achievement }),
        })}
      </p>
    </Scene>
  );
}

/** Browsers block audio until a gesture: one-tap unlock, or stay silent. Never blocks the scenes underneath. */
function SoundUnlock() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(() => !isAudioUnlocked());
  if (!open) return null;
  return (
    <div
      role="region"
      aria-label={t('display.soundTitle')}
      className="absolute bottom-6 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-4 rounded-xl bg-ink-900 px-6 py-4 text-white shadow-lg"
    >
      <p>{t('display.soundPrompt')}</p>
      <button
        type="button"
        className="min-h-12 rounded bg-gold-400 px-4 font-semibold text-ink-900"
        onClick={() => {
          unlockAudio();
          usePrefs.getState().set({ sound: true });
          setOpen(false);
        }}
      >
        {t('display.soundEnable')}
      </button>
      <button
        type="button"
        className="min-h-12 rounded border border-white px-4"
        onClick={() => setOpen(false)}
      >
        {t('display.soundSkip')}
      </button>
    </div>
  );
}
