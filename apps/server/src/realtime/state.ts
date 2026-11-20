import { and, desc, eq, gt, isNotNull, isNull, ne, or } from 'drizzle-orm';
import {
  VOTED_COUNTER_KEY,
  boardPublications,
  ceremonyView,
  eventAccess,
  auctionView,
  gameView,
  spotlightView,
  events,
  gifts,
  loadParticipantSources,
  loadPublishedVotedCount,
  pairings,
  revealStage,
  votingCategories,
  type Db,
} from '@santa/db';
import {
  XP_BOARD_KEY,
  eventFeatures,
  phase2Settings,
  phase3Settings,
  type AuctionViewOutput,
  type CeremonyViewOutput,
  type GameViewOutput,
  type RevealViewOutput,
  type SpotlightOutput,
} from '@santa/contracts';
import {
  giftLabel,
  type BoardSource,
  type EventSource,
  type GiftSource,
  projectReveal,
  type ParticipantSource,
  type PublishResult,
} from '@santa/domain';
import { PHOTO_URL_TTL_SECONDS, type StorageAdapter } from '../storage/adapter.js';

export interface RealtimeContext {
  storage?: StorageAdapter | undefined;
  /** Public base URL, used for the display's join URL. */
  baseUrl: string;
}

export async function loadEventSource(db: Db, eventId: string): Promise<EventSource> {
  const [e] = await db.select().from(events).where(eq(events.id, eventId));
  if (!e) throw new Error('event not found');
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    id: e.id,
    name: e.name,
    description: e.description,
    theme: e.theme,
    startsAt: e.startsAt.toISOString(),
    timezone: e.timezone,
    phase: e.phase,
    paused: e.paused,
    maxParticipants: e.maxParticipants,
    votingRound: e.votingRound,
    defaultLocale: e.defaultLocale === 'it' ? 'it' : 'en',
    votingEndsAt: iso(e.votingEndsAt),
    reactionsEnabled: e.settings.features.reactionsEnabled,
    features: eventFeatures(e.settings),
    phase2: phase2Settings(e.settings),
    phase3: phase3Settings(e.settings),
    currentGiftId: e.currentGiftId,
    openingCountdownSeconds: e.settings.openingCountdownSeconds,
    milestones: {
      giftOpeningStartedAt: iso(e.giftOpeningStartedAt),
      votingClosedAt: iso(e.votingClosedAt),
      revealStartedAt: iso(e.revealStartedAt),
      ceremonyStartedAt: iso(e.ceremonyStartedAt),
    },
  };
}

/** Recipient is derived from `pairings` (never stored on the gift). Photo URLs are short-lived signed URLs. */
export async function loadGiftSources(
  db: Db,
  eventId: string,
  storage?: StorageAdapter,
): Promise<GiftSource[]> {
  const rows = await db
    .select({ g: gifts, recipientId: pairings.recipientId })
    .from(gifts)
    .innerJoin(
      pairings,
      and(eq(pairings.eventId, gifts.eventId), eq(pairings.giverId, gifts.giverId)),
    )
    .where(eq(gifts.eventId, eventId));
  return Promise.all(
    rows.map(async ({ g, recipientId }) => ({
      id: g.id,
      aliasNo: g.aliasNo,
      name: g.name,
      description: g.description,
      photoUrl:
        g.photoKey && storage ? await storage.readUrl(g.photoKey, PHOTO_URL_TTL_SECONDS) : null,
      status: g.status,
      giverId: g.giverId,
      recipientId,
      openingOrder: g.openingOrder,
      createdAt: g.createdAt.toISOString(),
      openedAt: g.openedAt?.toISOString() ?? null,
      hidden: g.hidden,
    })),
  );
}

export interface EventContext {
  event: EventSource;
  people: ParticipantSource[];
  gifts: GiftSource[];
  votedCount: number | null;
  join: { url: string; shortCode: string } | null;
  /** entryId (gift id) -> "Gift N". Never contains a person. */
  labels: Record<string, string>;
  /** Published boards (excluding the voted-counter row). */
  boards: BoardSource[];
  /** Labels for a board's entries: gift aliases for categories, display names for the XP board. */
  labelsFor(boardKey: string): Record<string, string>;
  ceremony: CeremonyViewOutput | null;
  /** Phase 2: active mini-game and current presentation (public, validated views). */
  game: GameViewOutput | null;
  spotlight: SpotlightOutput | null;
  auction: AuctionViewOutput | null;
  /** Giver reveal show (reveal phase only; public, giver only once revealed). */
  reveal: RevealViewOutput | null;
}

export async function loadEventContext(
  db: Db,
  eventId: string,
  ctx: RealtimeContext,
  now = new Date(),
): Promise<EventContext> {
  const [
    event,
    people,
    giftRows,
    votedCount,
    access,
    boardRows,
    ceremony,
    cats,
    game,
    spotlight,
    auction,
    stage,
  ] = await Promise.all([
    loadEventSource(db, eventId),
    loadParticipantSources(db, eventId),
    loadGiftSources(db, eventId, ctx.storage),
    loadPublishedVotedCount(db, eventId),
    db
      .select({ shortCode: eventAccess.shortCode })
      .from(eventAccess)
      .where(
        and(
          eq(eventAccess.eventId, eventId),
          eq(eventAccess.kind, 'join'),
          isNotNull(eventAccess.shortCode),
          isNull(eventAccess.revokedAt),
          or(isNull(eventAccess.expiresAt), gt(eventAccess.expiresAt, now)),
        ),
      )
      .orderBy(desc(eventAccess.createdAt))
      .limit(1),
    db
      .select()
      .from(boardPublications)
      .where(
        and(
          eq(boardPublications.eventId, eventId),
          ne(boardPublications.boardKey, VOTED_COUNTER_KEY),
        ),
      ),
    ceremonyView(db, eventId),
    db
      .select({ key: votingCategories.key, name: votingCategories.name })
      .from(votingCategories)
      .where(eq(votingCategories.eventId, eventId)),
    gameView(db, eventId, now),
    spotlightView(db, eventId),
    auctionView(db, eventId),
    revealStage(db, eventId),
  ]);
  const code = access[0]?.shortCode ?? null;
  return {
    event,
    people,
    gifts: giftRows,
    votedCount,
    join: code ? { url: `${ctx.baseUrl}/j?code=${code}`, shortCode: code } : null,
    labels: Object.fromEntries(giftRows.map((g) => [g.id, giftLabel(g)])),
    labelsFor: (boardKey) =>
      boardKey === XP_BOARD_KEY
        ? Object.fromEntries(people.map((p) => [p.id, p.displayName]))
        : Object.fromEntries(giftRows.map((g) => [g.id, giftLabel(g)])),
    ceremony,
    game,
    spotlight,
    auction,
    reveal: stage
      ? projectReveal({
          gifts: giftRows,
          people,
          currentGiftId: stage.giftId,
          countdownEndsAt: stage.countdownEndsAt?.toISOString() ?? null,
        })
      : null,
    boards: boardRows.map((b) => ({
      boardKey: b.boardKey,
      name:
        b.boardKey === XP_BOARD_KEY
          ? { en: 'Christmas XP', it: 'XP di Natale' }
          : (cats.find((c) => c.key === b.boardKey)?.name ?? { en: b.boardKey }),
      state: b.state,
      lastPublished: b.lastPublished as PublishResult | null,
    })),
  };
}
