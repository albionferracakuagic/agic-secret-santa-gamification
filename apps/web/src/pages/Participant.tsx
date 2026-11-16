import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  EventStateOutput,
  PublicGiftListOutput,
  PublicLeaderboardOutput,
} from '@santa/contracts';
import { useParticipantApi } from '../api/participant';
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
  const board = surfaceOf<PublicLeaderboardOutput>(state, 'pub', 'leaderboard');
  const [saved, setSaved] = useState<Saved>();
  const shown = es?.me && { ...es.me, ...saved };

  const seen = useRef(0);
  useEffect(() => {
    const fresh = state.reactions.filter((r) => r.seq > seen.current);
    seen.current = state.reactions.at(-1)?.seq ?? seen.current;
    fresh.forEach((r) => floatReaction(r.kind));
  }, [state.reactions]);

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
            {shown.status === 'pending' && <p role="status">{t('join.pending')}</p>}
            <p>{t('participant.xp', { xp: shown.xp.xp, level: shown.xp.level })}</p>
          </header>
          <Profile me={shown} onSaved={setSaved} />
          <OwnSelections me={shown} gifts={gifts} />
          <Standing board={board} />
          {shown.status === 'active' && <ReactionBar send={(k) => rt?.sendReaction(k)} />}
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

/** FR-046: no ranks/totals for non-top; the participant app shows a neutral, encouraging message only. */
function Standing({ board }: { board: PublicLeaderboardOutput | undefined }) {
  const { t } = useTranslation();
  if (!board || board.state === 'hidden') return null;
  return (
    <section aria-labelledby="board-title" className="space-y-2">
      <h2 id="board-title" className="font-semibold">
        {t('participant.boardTitle')}
      </h2>
      <p>{t('participant.encourage')}</p>
    </section>
  );
}
