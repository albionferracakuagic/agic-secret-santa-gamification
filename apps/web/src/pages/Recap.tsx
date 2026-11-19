import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type {
  EventStateOutput,
  PublicGiftListOutput,
  PublicGiftOutput,
  SceneOutput,
} from '@santa/contracts';
import { surfaceOf, useRealtime } from '../realtime/react';
import { usePlayApi } from '../api/play';
import { usePhase2Api } from '../api/phase2';
import { usePhase3Api } from '../api/phase3';
import type { BoardsOutput } from '../components/Podium';
import { useBoardName } from '../components/Podium';
import { useAchievementName } from '../components/play/Achievements';
import { Certificates } from '../components/play/Certificates';
import { useLocalized } from '../lib/localized';
import { avatarGlyph } from '../fx/avatars';
import { isReducedMotion, usePrefs } from '../prefs/store';
import { isRecapPhase } from '../routes/recap';

type PState = Extract<EventStateOutput, { role: 'participant' }>;
type Person = { participantId: string; displayName: string; avatar: string | null };
type Winner = {
  key: string;
  category: string;
  grand: boolean;
  label: string;
  giftName: string | null;
  photoUrl: string | null;
  /** Only ever set from data where the giver is already revealed (archive / revealed gallery gift). */
  giver: Person | null;
};

/**
 * Post-event recap (/e/recap). Renders ONLY what the participant projection and the participant
 * endpoints already send: no ranks beyond the published top, no totals that the server did not send,
 * givers only once revealed (ADR-0003/0007, FR-046).
 */
export default function Recap() {
  const { t } = useTranslation();
  const { state } = useRealtime();
  const es = surfaceOf<PState>(state, 'participant', 'eventState');
  const ready = isRecapPhase(es?.phase);
  return (
    <section aria-labelledby="recap-title" className="mx-auto max-w-5xl space-y-6">
      <h1 id="recap-title" className="text-3xl font-bold lg:text-5xl">
        <span aria-hidden="true">🎄 </span>
        {t('recap.title')}
      </h1>
      {!es && <p role="status">{t('participant.connecting')}</p>}
      {es && !ready && (
        <div
          role="status"
          data-testid="recap-locked"
          className="space-y-3 rounded-2xl bg-pine-900 p-6 text-center text-white"
        >
          <p aria-hidden="true" className="text-5xl">
            🎁
          </p>
          <p className="text-xl font-semibold">{t('recap.locked')}</p>
          <p>{t('recap.lockedHint')}</p>
          <BackLink />
        </div>
      )}
      {es && ready && <RecapBody es={es} />}
    </section>
  );
}

function BackLink() {
  const { t } = useTranslation();
  return (
    <Link
      to="/e"
      className="inline-flex min-h-12 items-center rounded bg-white px-4 font-semibold text-ink-900 underline"
    >
      {t('recap.back')}
    </Link>
  );
}

/** Subtle staggered rise-in; nothing animates when the user/system asks for reduced motion. */
function useRise() {
  const prefs = usePrefs();
  const still = isReducedMotion(prefs);
  return (i: number): { className: string; style?: CSSProperties } =>
    still
      ? { className: '' }
      : { className: 'recap-rise', style: { animationDelay: `${i * 90}ms` } };
}

function Card({
  id,
  title,
  icon,
  index,
  children,
  testId,
}: {
  id: string;
  title: string;
  icon: string;
  index: number;
  children: ReactNode;
  testId?: string;
}) {
  const rise = useRise()(index);
  return (
    <section
      aria-labelledby={id}
      data-testid={testId}
      className={`space-y-3 rounded-2xl border-2 border-gold-400 bg-white p-4 shadow-sm lg:p-6 ${rise.className}`}
      style={rise.style}
    >
      <h2 id={id} className="text-xl font-semibold lg:text-2xl">
        <span aria-hidden="true">{icon} </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function PersonName({ p }: { p: Person }) {
  return (
    <>
      <span aria-hidden="true">{avatarGlyph(p.avatar)}</span> {p.displayName}
    </>
  );
}

function RecapBody({ es }: { es: PState }) {
  const { t } = useTranslation();
  const { state } = useRealtime();
  const gifts = surfaceOf<PublicGiftListOutput>(state, 'pub', 'giftList');
  const boards = surfaceOf<BoardsOutput>(state, 'pub', 'leaderboards');
  const scene = surfaceOf<SceneOutput>(state, 'pub', 'scene');
  const play = usePlayApi();
  const p2 = usePhase2Api();
  const p3 = usePhase3Api();
  const loc = useLocalized();
  const boardName = useBoardName();
  const achName = useAchievementName();

  const hist = useQuery({ queryKey: ['history'], queryFn: () => p3.myHistory() });
  const mine = useQuery({ queryKey: ['my-achievements'], queryFn: () => play.myAchievements() });
  const own = useQuery({ queryKey: ['gift'], queryFn: () => play.getGift() });
  const assignment = useQuery({ queryKey: ['assignment'], queryFn: () => play.assignment() });
  const certs = useQuery({ queryKey: ['my-certificates'], queryFn: () => p2.myCertificates() });

  const archive = hist.data?.archive ?? null;
  const gallery: PublicGiftOutput[] = gifts?.mode === 'gallery' ? gifts.gifts : [];
  const byId = new Map(gallery.map((g) => [g.giftId, g]));

  // Winners: the completed-event archive when present, otherwise the published rank-1 entries.
  const winners: Winner[] = archive
    ? archive.winners.map((w) => ({
        key: w.boardKey,
        category: loc(w.name),
        grand: w.grand,
        label: w.giftLabel,
        giftName: w.giftName,
        photoUrl: w.photoUrl,
        giver: w.giver,
      }))
    : (boards?.boards ?? [])
        .filter((b) => b.state !== 'hidden')
        .flatMap((b) =>
          b.entries
            .filter((e) => e.rank === 1)
            .map((e) => {
              const g = byId.get(e.entryId);
              const title = Object.keys(b.name).length ? loc(b.name) : boardName(b.boardKey);
              return {
                key: `${b.boardKey}-${e.entryId}`,
                category: title,
                grand: false,
                label: e.label,
                giftName: g?.name ?? null,
                photoUrl: g?.photoUrl ?? null,
                giver: g?.status === 'revealed' ? g.giver : null,
              };
            }),
        );

  const ceremonyChampion =
    scene?.scene === 'ceremony' && scene.ceremony.step?.type === 'champion'
      ? scene.ceremony.step.person
      : null;
  const champion = archive?.champion ?? ceremonyChampion;

  // My Secret Santa: only from an already-revealed pair addressed to me (never a drumroll / unrevealed gift).
  const myId = es.me.participantId;
  const mySanta =
    scene?.scene === 'reveal'
      ? (scene.reveal.revealed.find((r) => r.recipient?.participantId === myId) ??
        (scene.reveal.current?.stage === 'revealed' &&
        scene.reveal.current.recipient?.participantId === myId
          ? scene.reveal.current
          : null))
      : null;

  const myAchievements = mine.data?.achievements ?? [];
  const ownGift = own.data?.gift ?? null;
  const recipient = assignment.data?.recipient ?? null;
  const revealedCount = gallery.filter((g) => g.status === 'revealed').length;
  const stats: Array<[string, number]> = [
    [t('recap.stats.players'), es.counts.participants],
    [t('recap.stats.gifts'), es.counts.giftsRegistered],
    ...(typeof es.votedCount === 'number'
      ? ([[t('recap.stats.voted'), es.votedCount]] as Array<[string, number]>)
      : []),
    ...(revealedCount > 0
      ? ([[t('recap.stats.revealed'), revealedCount]] as Array<[string, number]>)
      : []),
    ...(winners.length > 0
      ? ([[t('recap.stats.awards'), winners.length]] as Array<[string, number]>)
      : []),
  ];

  let i = 0;
  return (
    <div className="space-y-6">
      <p className="text-lg lg:text-2xl">{t('recap.intro', { name: es.name })}</p>

      <div className="grid gap-6 lg:grid-cols-2">
        {champion && (
          <Card
            id="recap-champion"
            title={t('recap.champion')}
            icon="🏆"
            index={i++}
            testId="recap-champion"
          >
            <p className="rounded-xl bg-gold-400 p-4 text-center text-2xl font-bold text-ink-900 lg:text-4xl">
              <PersonName p={champion} />
            </p>
          </Card>
        )}

        <Card id="recap-winners" title={t('recap.winners')} icon="🌟" index={i++}>
          {winners.length === 0 ? (
            <p>{t('recap.noWinners')}</p>
          ) : (
            <ul className="space-y-3" data-testid="recap-winners">
              {winners.map((w) => (
                <li key={w.key} className="flex items-center gap-3 rounded-xl bg-snow-100 p-3">
                  {w.photoUrl ? (
                    <img
                      src={w.photoUrl}
                      alt={w.giftName ?? w.label}
                      className="h-16 w-16 shrink-0 rounded-lg object-cover"
                    />
                  ) : (
                    <span aria-hidden="true" className="text-4xl">
                      {w.grand ? '🌟' : '🎁'}
                    </span>
                  )}
                  <div>
                    <p className="font-semibold">{w.category}</p>
                    <p>
                      {w.label}
                      {w.giftName ? ` · ${w.giftName}` : ''}
                    </p>
                    {w.giver && (
                      <p>
                        {t('recap.from')} <PersonName p={w.giver} />
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card id="recap-mine" title={t('recap.myGift')} icon="🎅" index={i++} testId="recap-mine">
          {mySanta && (
            <p className="text-lg font-semibold" data-testid="recap-my-santa">
              {t('recap.mySanta')} <PersonName p={mySanta.giver} />
              {' · '}
              {mySanta.giftName}
            </p>
          )}
          {ownGift && <p>{t('recap.broughtGift', { name: ownGift.name })}</p>}
          {recipient && (
            <p>
              {t('recap.gaveTo')} <PersonName p={recipient} />
            </p>
          )}
          {!mySanta && !ownGift && !recipient && <p>{t('recap.myGiftNone')}</p>}
        </Card>

        <Card id="recap-ach" title={t('recap.myAchievements')} icon="🏅" index={i++}>
          {myAchievements.length === 0 ? (
            <p>{t('recap.noAchievements')}</p>
          ) : (
            <ul className="flex flex-wrap gap-2" data-testid="recap-achievements">
              {myAchievements.map((a) => (
                <li
                  key={a.key}
                  className="rounded-full bg-gold-400 px-4 py-2 font-semibold text-ink-900"
                >
                  🏅 {achName(a.key)}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card id="recap-stats" title={t('recap.statsTitle')} icon="📊" index={i++}>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="recap-stats">
            {stats.map(([label, n]) => (
              <div key={label} className="rounded-xl bg-pine-900 p-3 text-center text-white">
                <dt className="text-sm">{label}</dt>
                <dd className="text-3xl font-bold">{n}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      {gallery.length > 0 && (
        <Card id="recap-gallery" title={t('recap.gallery')} icon="🖼️" index={i}>
          <ul
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
            data-testid="recap-gallery"
          >
            {gallery.map((g) => (
              <li key={g.giftId} className="space-y-1 rounded-xl bg-snow-100 p-2">
                {g.photoUrl ? (
                  <img
                    src={g.photoUrl}
                    alt={g.name}
                    loading="lazy"
                    className="aspect-square w-full rounded-lg object-cover"
                  />
                ) : (
                  <p aria-hidden="true" className="py-4 text-center text-5xl">
                    🎁
                  </p>
                )}
                <p className="font-semibold">{g.name}</p>
                <p className="text-sm">{g.alias}</p>
                {g.status === 'revealed' && (
                  <p className="text-sm">
                    {t('recap.from')} <PersonName p={g.giver} />
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(certs.data?.certificates.length ?? 0) > 0 && <Certificates />}

      <BackLink />
    </div>
  );
}
