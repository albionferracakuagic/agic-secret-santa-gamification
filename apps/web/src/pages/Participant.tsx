import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  EventStateOutput,
  PublicGiftListOutput,
  SceneOutput,
  AnyAnnouncementOutput,
} from '@santa/contracts';
import { PHASES } from '@santa/contracts';
import { useQuery } from '@tanstack/react-query';
import { useParticipantApi } from '../api/participant';
import { usePlayApi } from '../api/play';
import { GiftForm, AssignmentView } from '../components/play/GiftForm';
import { VotingPanel } from '../components/play/Voting';
import { OpeningStage } from '../components/OpeningStage';
import { BoardsView, type BoardsOutput } from '../components/Podium';
import { CeremonyScene } from '../components/CeremonyScene';
import { AchievementUnlock, MyAchievements } from '../components/play/Achievements';
import { GuessPanel } from '../components/play/GuessPanel';
import { MissionsPanel } from '../components/play/MissionsPanel';
import { GamePanel } from '../components/play/GamePanel';
import { Certificates } from '../components/play/Certificates';
import { DeleteMyData } from '../components/play/DeleteMyData';
import { Link } from 'react-router-dom';
import { AVATAR_GLYPH, avatarGlyph } from '../fx/avatars';
import { surfaceOf, useRealtime } from '../realtime/react';
import { ReactionBar } from '../components/ReactionBar';
import { floatReaction } from '../fx/reactions';

type PState = Extract<EventStateOutput, { role: 'participant' }>;
type Me = PState['me'];
type Saved = Pick<Me, 'displayName' | 'avatar'>;

export default function Participant() {
  const { t } = useTranslation();
  const { rt, state } = useRealtime();
  const es = surfaceOf<PState>(state, 'participant', 'eventState');
  const gifts = surfaceOf<PublicGiftListOutput>(state, 'pub', 'giftList');
  const boards = surfaceOf<BoardsOutput>(state, 'pub', 'leaderboards');
  const announcement = surfaceOf<AnyAnnouncementOutput>(state, 'participant', 'announcement');
  const scene = surfaceOf<SceneOutput>(state, 'pub', 'scene');
  const [saved, setSaved] = useState<Saved>();
  const shown = es?.me && { ...es.me, ...saved };
  const now = () => rt?.serverNow() ?? Date.now();

  const seen = useRef(0);
  useEffect(() => {
    const fresh = state.reactions.filter((r) => r.seq > seen.current);
    seen.current = state.reactions.at(-1)?.seq ?? seen.current;
    fresh.forEach((r) => floatReaction(r.kind));
  }, [state.reactions]);

  const phase = es?.phase;
  const active = shown?.status === 'active';
  const reached = (p: (typeof PHASES)[number]) =>
    !!phase && PHASES.indexOf(phase) >= PHASES.indexOf(p);
  return (
    <section aria-labelledby="part-title" className="space-y-6">
      <h1 id="part-title" className="text-2xl font-bold">
        {t('route.participant')}
      </h1>
      {!es && <p role="status">{t('participant.connecting')}</p>}
      {es && shown && (
        <>
          <header className="space-y-1">
            <p className="text-lg font-semibold">{es.name}</p>
            <p>
              <span aria-hidden="true">{avatarGlyph(shown.avatar)}</span> {shown.displayName}
            </p>
            <p>{t('participant.phase', { phase: t(`phase.${es.phase}`) })}</p>
            {es.paused && <p role="status">{t('console.paused')}</p>}
            <p>{t('participant.counts', { n: es.counts.participants })}</p>
            {phase === 'gift_registration' && (
              <p>{t('gift.countOnly', { count: es.counts.giftsRegistered })}</p>
            )}
            {shown.status === 'pending' && <p role="status">{t('join.pending')}</p>}
            <p>{t('participant.xp', { xp: shown.xp.xp, level: shown.xp.level })}</p>
          </header>
          {active && phase === 'gift_registration' && <GiftForm canEdit />}
          {active && phase !== 'preparation' && phase !== 'registration' && <AssignmentView />}
          {active && phase === 'gift_opening' && (
            <section aria-labelledby="open-title" className="space-y-2">
              <h2 id="open-title" className="font-semibold">
                {t('opening.title')}
              </h2>
              {scene?.scene === 'opening' ? (
                <OpeningStage
                  current={scene.current}
                  countdownEndsAt={scene.countdownEndsAt}
                  now={now}
                  openedCount={scene.openedCount}
                  total={scene.total}
                />
              ) : (
                <p>{t('opening.waiting')}</p>
              )}
              <GiftForm canEdit={false} />
            </section>
          )}
          {active && phase === 'voting' && (
            <VotingPanel
              gifts={gifts}
              votedCount={es.votedCount}
              endsAt={es.votingEndsAt}
              now={now}
            />
          )}
          {active && <GamePanel scene={scene} now={now} />}
          {active && reached('gift_opening') && <GuessPanel selfId={shown.participantId} />}
          {active && reached('gift_registration') && <MissionsPanel />}
          {phase !== 'voting' && <OwnSelections me={shown} gifts={gifts} />}
          {(phase === 'reveal' || phase === 'awards' || phase === 'completed') && (
            <RevealList gifts={gifts} />
          )}
          {scene?.scene === 'ceremony' && <CeremonyScene view={scene.ceremony} now={now} />}
          <AchievementUnlock announcement={announcement} ready={!!es} />
          <Standing boards={boards} />
          {active && <MyAchievements />}
          {active && <Certificates />}
          {active && <ReactionBar send={(k) => rt?.sendReaction(k)} />}
          <Profile me={shown} onSaved={setSaved} />
          <DeleteMyData />
        </>
      )}
    </section>
  );
}
function Profile({ me, onSaved }: { me: Me; onSaved: (m: Saved) => void }) {
  const { t } = useTranslation();
  const api = useParticipantApi();
  const [name, setName] = useState(me.displayName);
  const [avatar, setAvatar] = useState(me.avatar);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(false);
    setSaved(false);
    try {
      const u = await api.updateProfile({ displayName: name.trim(), avatar });
      onSaved({ displayName: u.displayName, avatar: u.avatar });
      setSaved(true);
    } catch {
      setErr(true);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3" aria-labelledby="profile-title">
      <h2 id="profile-title" className="font-semibold">
        {t('participant.profile')}
      </h2>
      <label className="block">
        {t('participant.name')}
        <input
          className="mt-1 block min-h-12 w-full rounded border border-ink-900/40 bg-white px-3"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <fieldset>
        <legend>{t('participant.avatar')}</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {Object.entries(AVATAR_GLYPH).map(([id, glyph]) => (
            <button
              key={id}
              type="button"
              aria-pressed={avatar === id}
              aria-label={t(`avatar.${id}`)}
              className="min-h-12 min-w-12 rounded border border-ink-900/30 bg-white text-2xl aria-pressed:border-4 aria-pressed:border-pine-700"
              onClick={() => setAvatar(id)}
            >
              {glyph}
            </button>
          ))}
        </div>
      </fieldset>
      <button
        className="min-h-12 rounded bg-santa-600 px-4 font-semibold text-white"
        disabled={name.trim().length === 0}
      >
        {t('participant.save')}
      </button>
      <p role="status">
        {saved ? t('participant.saved') : ''}
        {err ? t('error.generic') : ''}
      </p>
    </form>
  );
}

/** Only the caller's own selections (from `me.votes`); never anyone else's. */
function OwnSelections({ me, gifts }: { me: Me; gifts: PublicGiftListOutput | undefined }) {
  const { t } = useTranslation();
  const named = (id: string) =>
    gifts?.mode === 'gallery' ? gifts.gifts.find((g) => g.giftId === id)?.name : undefined;
  return (
    <section aria-labelledby="sel-title" className="space-y-2">
      <h2 id="sel-title" className="font-semibold">
        {t('participant.selections')}
      </h2>
      {me.votes.length === 0 ? (
        <p>{t('participant.noSelections')}</p>
      ) : (
        <ul className="list-disc pl-5">
          {me.votes.map((v) => (
            <li key={v.categoryId}>{named(v.giftId) ?? t('participant.yourPick')}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RevealList({ gifts }: { gifts: PublicGiftListOutput | undefined }) {
  const { t } = useTranslation();
  const list = gifts?.mode === 'gallery' ? gifts.gifts.filter((g) => g.status === 'revealed') : [];
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="reveal-title" className="space-y-2">
      <h2 id="reveal-title" className="font-semibold">
        {t('reveal.title')}
      </h2>
      <ul className="space-y-1" data-testid="reveal-list">
        {list.map((g) =>
          g.status === 'revealed' ? (
            <li key={g.giftId}>
              {g.alias}: {g.name} — {t('reveal.from')}{' '}
              <span aria-hidden="true">{avatarGlyph(g.giver.avatar)}</span>{' '}
              <Link className="underline" to={`/e/profile/${g.giver.participantId}`}>
                {g.giver.displayName}
              </Link>
            </li>
          ) : null,
        )}
      </ul>
    </section>
  );
}

/** FR-046: only the published top-N is shown; everyone else gets a neutral, encouraging message (no rank, no totals). */
function Standing({ boards }: { boards: BoardsOutput | undefined }) {
  const { t } = useTranslation();
  const api = usePlayApi();
  const mine = useQuery({ queryKey: ['gift'], queryFn: () => api.getGift() });
  const visible = boards?.boards.filter((b) => b.state !== 'hidden') ?? [];
  if (visible.length === 0) return null;
  const myId = mine.data?.gift?.giftId;
  const onBoard = !!myId && visible.some((b) => b.entries.some((e) => e.entryId === myId));
  return (
    <section aria-labelledby="board-title" className="space-y-2">
      <h2 id="board-title" className="font-semibold">
        {t('participant.boardTitle')}
      </h2>
      <div className="rounded bg-pine-900 p-3 text-white">
        <BoardsView boards={boards} />
      </div>
      <p>{t(onBoard ? 'participant.onBoard' : 'participant.encourage')}</p>
    </section>
  );
}
