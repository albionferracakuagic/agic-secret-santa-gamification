import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router-dom';
import type {
  AnyAnnouncementOutput,
  EventStateOutput,
  PublicGiftListOutput,
  SceneOutput,
} from '@santa/contracts';
import { useParticipantApi } from '../api/participant';
import { avatarGlyph } from '../fx/avatars';
import { floatReaction } from '../fx/reactions';
import { surfaceOf, useRealtime } from '../realtime/react';
import { formatShortCode } from '../lib/shortCode';
import { Qr } from '../components/Qr';
import { Countdown } from '../components/Countdown';
import {
  announcementFx,
  announcementLine,
  useAchievementName,
} from '../components/play/Achievements';
import { OpeningStage } from '../components/OpeningStage';
import { RevealStage } from '../components/display/RevealStage';
import { BoardsView, type BoardsOutput } from '../components/Podium';
import { CeremonyScene } from '../components/CeremonyScene';
import { AuctionScene, GameScene, SpotlightScene } from '../components/GameScenes';
import { emitFx } from '../fx/bus';
import { useLocalized } from '../lib/localized';
import { isAudioUnlocked, unlockAudio } from '../fx/audio';
import { usePrefs } from '../prefs/store';

type DState = Extract<EventStateOutput, { role: 'display' }>;

const STAGE_W = 1920;
const STAGE_H = 1080;
const ANNOUNCE_MS = 8000;

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

/** Fires only on changes after the first snapshot, never on initial load. */
function usePrevEffect<T>(v: T | undefined, fn: (prev: T, next: T | undefined) => void) {
  const prev = useRef<T | undefined>(undefined);
  const first = useRef(true);
  useEffect(() => {
    if (!first.current && prev.current !== undefined) fn(prev.current, v);
    first.current = false;
    prev.current = v;
  }, [v]);
}

/** /d[/<token>] — exchanges the display token for its cookie first, and only then opens the realtime stream. */
export default function Display() {
  const { t } = useTranslation();
  const api = useParticipantApi();
  const token = useParams()['*']?.split('/')[0];
  const [exchange, setExchange] = useState<{
    token: string;
    status: 'pending' | 'success' | 'failed';
  }>();
  useEffect(() => {
    if (!token) return;
    let active = true;
    setExchange({ token, status: 'pending' });
    void api.exchangeDisplayToken(token).then(
      () => active && setExchange({ token, status: 'success' }),
      () => active && setExchange({ token, status: 'failed' }),
    );
    return () => {
      active = false;
    };
  }, [token, api]);
  if (!token) return <DisplayStage />;
  if (exchange?.token !== token || exchange.status === 'pending') return null;
  if (exchange.status === 'failed')
    return <p role="alert">{t('join.error.invalid_claim')}</p>;
  return <DisplayStage />;
}

/** Renders only the display projection (scene, event state, gift list, leaderboard, announcement). */
function DisplayStage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const { rt, state } = useRealtime();
  const projected = state.surfaces.pub?.eventState;
  const es =
    typeof projected === 'object' &&
    projected !== null &&
    'role' in projected &&
    projected.role === 'display' &&
    'eventId' in projected &&
    typeof projected.eventId === 'string'
      ? (projected as DState)
      : undefined;
  const scene = surfaceOf<SceneOutput>(state, 'pub', 'scene');
  const gifts = surfaceOf<PublicGiftListOutput>(state, 'pub', 'giftList');
  const boards = surfaceOf<BoardsOutput>(state, 'pub', 'leaderboards');
  const announcement = surfaceOf<AnyAnnouncementOutput>(state, 'pub', 'announcement');
  const scale = useStageScale();
  const now = () => rt?.serverNow() ?? Date.now();
  usePrevEffect(
    es?.counts.participants,
    (p, n) => n !== undefined && p < n && emitFx('participant_joined'),
  );
  usePrevEffect(
    es?.counts.giftsRegistered,
    (p, n) => n !== undefined && p < n && emitFx('gift_registered'),
  );
  usePrevEffect(es?.votedCount, (p, n) => n !== undefined && p < n && emitFx('vote_submitted'));
  usePrevEffect(scene?.scene, (_p, n) => n === 'voting' && emitFx('voting_started'));
  usePrevEffect(
    es && (boards?.boards.map((b) => b.entries[0]?.entryId ?? '').join('|') ?? ''),
    (_p, n) => n && emitFx('leaderboard_entry'),
  );
  usePrevEffect(
    gifts &&
      (gifts.mode === 'gallery' ? gifts.gifts.filter((g) => g.status === 'revealed').length : 0),
    (p, n) => n !== undefined && p < n && emitFx('correct_guess'),
  );
  usePrevEffect(state.reactions.at(-1)?.seq ?? 0, () => {
    const last = state.reactions.at(-1);
    if (last) floatReaction(last.kind);
  });

  const joinUrl = params.get('join');
  const shortCode = params.get('code');

  let body: ReactNode;
  if (!es || !scene) body = <Scene title={t('display.waiting')} />;
  else if (scene.scene === 'lobby')
    body = (
      <LobbyScene
        name={es.name}
        participants={scene.participants}
        joinUrl={scene.joinUrl ?? joinUrl ?? `${location.origin}/j`}
        code={scene.shortCode ?? shortCode}
      />
    );
  else if (scene.scene === 'opening')
    body = (
      <Scene title={t('display.openingTitle')}>
        <OpeningStage
          big
          current={scene.current}
          countdownEndsAt={scene.countdownEndsAt}
          now={now}
          openedCount={scene.openedCount}
          total={scene.total}
        />
      </Scene>
    );
  else if (scene.scene === 'voting')
    body = (
      <Scene title={t(scene.closed ? 'display.votingClosed' : 'display.votingTitle')}>
        {!scene.closed && scene.endsAt && (
          <Countdown endsAt={scene.endsAt} now={now} className="text-[12rem]" />
        )}
        {scene.votedCount !== null && <Big n={scene.votedCount} label={t('display.voted')} />}
      </Scene>
    );
  else if (scene.scene === 'ceremony') body = <CeremonyScene big view={scene.ceremony} now={now} />;
  else if (scene.scene === 'game') body = <GameScene game={scene.game} now={now} />;
  else if (scene.scene === 'spotlight') body = <SpotlightScene spotlight={scene.spotlight} />;
  else if (scene.scene === 'auction') body = <AuctionScene auction={scene.auction} now={now} />;
  else if (scene.scene === 'reveal') body = <RevealStage reveal={scene.reveal} now={now} />;
  else if (scene.phase === 'gift_registration')
    body = (
      <Scene title={t('display.registrationTitle')}>
        <Big n={es.counts.giftsRegistered} label={t('display.giftsRegistered')} />
        <p className="text-4xl">{t('display.outOf', { n: es.counts.participants })}</p>
      </Scene>
    );
  else if (scene.phase === 'reveal') body = <RevealScene gifts={gifts} boards={boards} />;
  else if (['games', 'awards', 'completed'].includes(scene.phase))
    body = (
      <Scene title={t('display.boardTitle')}>
        <BoardsView big boards={boards} />
      </Scene>
    );
  else body = <Scene title={t(`phase.${scene.phase}`)} />;

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
        {body}
        <AnnouncementOverlay announcement={announcement} ready={!!es} />
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

function LobbyScene({
  name,
  participants,
  joinUrl,
  code,
}: {
  name: string;
  participants: number;
  joinUrl: string;
  code: string | null;
}) {
  const { t } = useTranslation();
  return (
    <Scene title={t('display.welcome', { event: name })}>
      <div className="flex items-center gap-24">
        <div className="h-[420px] w-[420px] rounded-2xl bg-white p-4 text-ink-900">
          <Qr value={joinUrl} label={t('display.qrLabel')} />
        </div>
        <div className="space-y-6 text-left">
          <p className="text-4xl">{t('display.scanToJoin')}</p>
          {code && <p className="text-7xl font-bold tracking-widest">{formatShortCode(code)}</p>}
          <Big n={participants} label={t('display.joined')} />
        </div>
      </div>
    </Scene>
  );
}

function RevealScene({
  gifts,
  boards,
}: {
  gifts: PublicGiftListOutput | undefined;
  boards: BoardsOutput | undefined;
}) {
  const { t } = useTranslation();
  const revealed =
    gifts?.mode === 'gallery' ? gifts.gifts.filter((g) => g.status === 'revealed') : [];
  return (
    <Scene title={t('display.revealTitle')}>
      {revealed.length > 0 ? (
        <ul
          className="flex max-w-[1700px] flex-wrap justify-center gap-6 text-4xl"
          data-testid="reveal-grid"
        >
          {revealed.map((g) =>
            g.status === 'revealed' ? (
              <li key={g.giftId} className="rounded-2xl bg-white/15 px-8 py-4">
                🎁 {g.name}
                <br />
                <span className="text-3xl">
                  {t('reveal.from')} <span aria-hidden="true">{avatarGlyph(g.giver.avatar)}</span>{' '}
                  {g.giver.displayName}
                </span>
              </li>
            ) : null,
          )}
        </ul>
      ) : (
        <BoardsView big boards={boards} />
      )}
    </Scene>
  );
}

/** One-off celebration for a new announcement (non-blocking; text is also announced via the FX live region). */
function AnnouncementOverlay({
  announcement,
  ready,
}: {
  announcement: AnyAnnouncementOutput | undefined;
  ready: boolean;
}) {
  const { t } = useTranslation();
  const achievementName = useAchievementName();
  const loc = useLocalized();
  const [shown, setShown] = useState<AnyAnnouncementOutput>();
  const baseline = useRef<{ set: boolean; at?: string | undefined }>({ set: false });
  useEffect(() => {
    if (!ready) return;
    if (!baseline.current.set) {
      baseline.current = { set: true, at: announcement?.at }; // whatever the first snapshot held is history
      return;
    }
    if (!announcement || announcement.at === baseline.current.at) return;
    baseline.current.at = announcement.at;
    if (announcement.type === 'guess_result') return; // personal: never rendered on the public display
    setShown(announcement);
    emitFx(announcementFx(announcement));
    const id = setTimeout(() => setShown(undefined), ANNOUNCE_MS);
    return () => clearTimeout(id);
  }, [announcement, ready]);
  if (!shown || shown.type === 'guess_result') return null;
  const other =
    shown.type === 'achievement' ? undefined : announcementLine(shown, t, achievementName, loc);
  const line =
    shown.type === 'achievement'
      ? t('display.achievementLine', {
          name: shown.person.displayName,
          achievement: achievementName(shown.key),
        })
      : shown.type === 'clue'
        ? t('display.clueLine', { alias: shown.alias, text: shown.text })
        : (other?.text ?? '');
  const icon =
    shown.type === 'achievement' ? avatarGlyph(shown.person.avatar) : (other?.icon ?? '');
  return (
    <div
      role="status"
      data-testid="announcement"
      className="absolute inset-x-24 top-16 z-10 flex items-center justify-center gap-8 rounded-3xl bg-gold-400 px-12 py-8 text-ink-900 shadow-2xl"
    >
      <span aria-hidden="true" className="text-8xl">
        {icon}
      </span>
      <p className="text-5xl font-bold">{line}</p>
    </div>
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
