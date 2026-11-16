import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { EventSettings } from '@santa/contracts';
import { PHASES } from '@santa/contracts';

const id = () => uuid('id').primaryKey().defaultRandom();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();

export const phaseEnum = pgEnum('phase', PHASES);
export const participantStatus = pgEnum('participant_status', [
  'unclaimed',
  'pending',
  'active',
  'removed',
]);
export const claimMethod = pgEnum('claim_method', [
  'email_link',
  'personal_code',
  'organizer_approved',
]);
export const participantSource = pgEnum('participant_source', ['import', 'join']);
export const organizerRole = pgEnum('organizer_role', ['owner', 'co']);
export const accessKind = pgEnum('access_kind', ['join', 'display']);
export const importStatus = pgEnum('import_status', ['draft', 'ready']);
export const pairingSource = pgEnum('pairing_source', ['import', 'manual']);
export const giftStatus = pgEnum('gift_status', ['registered', 'opened', 'revealed']);
export const boardState = pgEnum('board_state', ['hidden', 'live', 'paused']);
export const jobStatus = pgEnum('job_status', [
  'pending',
  'running',
  'done',
  'failed',
  'cancelled',
]);

/* ---------- Better Auth (organizer accounts only; ADR-0004) ---------- */
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: ts('expires_at').notNull(),
    token: text('token').notNull().unique(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('session_user_idx').on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: ts('access_token_expires_at'),
    refreshTokenExpiresAt: ts('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('account_user_idx').on(t.userId)],
);

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/* ---------- Events ---------- */
export const events = pgTable(
  'events',
  {
    id: id(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    name: text('name').notNull(),
    startsAt: ts('starts_at').notNull(),
    timezone: text('timezone').notNull(),
    description: text('description'),
    theme: text('theme').notNull().default('classic'),
    budgetText: text('budget_text'),
    maxParticipants: integer('max_participants').notNull().default(100),
    phase: phaseEnum('phase').notNull().default('preparation'),
    paused: boolean('paused').notNull().default(false),
    giftOpeningStartedAt: ts('gift_opening_started_at'),
    votingClosedAt: ts('voting_closed_at'),
    revealStartedAt: ts('reveal_started_at'),
    ceremonyStartedAt: ts('ceremony_started_at'),
    votingRound: integer('voting_round').notNull().default(1),
    /** Server deadline for the voting timer (null = no timer / not open). */
    votingEndsAt: ts('voting_ends_at'),
    /** Gift currently being opened (opening phase); plain uuid, no FK (gifts reference events). */
    currentGiftId: uuid('current_gift_id'),
    settings: jsonb('settings').$type<EventSettings>().notNull(),
    defaultLocale: text('default_locale').notNull().default('en'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('events_owner_idx').on(t.ownerId)],
);

export const eventOrganizers = pgTable(
  'event_organizers',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: organizerRole('role').notNull(),
    participantId: uuid('participant_id'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.userId] })],
);

export const eventAccess = pgTable(
  'event_access',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    kind: accessKind('kind').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    shortCode: text('short_code'),
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('event_access_short_code_uq').on(t.shortCode),
    index('event_access_event_idx').on(t.eventId),
  ],
);

export const participants = pgTable(
  'participants',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    avatar: text('avatar'),
    email: text('email'),
    status: participantStatus('status').notNull().default('unclaimed'),
    source: participantSource('source').notNull(),
    claimMethod: claimMethod('claim_method'),
    claimVerifiedAt: ts('claim_verified_at'),
    claimCodeHash: text('claim_code_hash'),
    sessionTokenHash: text('session_token_hash'),
    locale: text('locale').notNull().default('en'),
    prefs: jsonb('prefs').$type<Record<string, unknown>>().notNull().default({}),
    /** Organizer mute: this participant's reactions are silently dropped. */
    reactionsMuted: boolean('reactions_muted').notNull().default(false),
    userId: text('user_id').references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('participants_event_idx').on(t.eventId),
    // one active session per roster entry: a session token maps to exactly one entry
    uniqueIndex('participants_session_uq').on(t.sessionTokenHash),
    unique('participants_event_id_uq').on(t.eventId, t.id),
  ],
);

/** Single-use personal claim credentials (emailed link token or printed code); only hashes are stored. */
export const claimTokens = pgTable(
  'claim_tokens',
  {
    id: id(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    method: claimMethod('method').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('claim_tokens_participant_idx').on(t.participantId)],
);

export const pairingImports = pgTable('pairing_imports', {
  id: id(),
  eventId: uuid('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'cascade' }),
  fileName: text('file_name'),
  fileSize: integer('file_size'),
  columnMapping: jsonb('column_mapping').$type<Record<string, string>>(),
  issueSummary: jsonb('issue_summary').$type<Record<string, number>>(),
  status: importStatus('status').notNull().default('draft'),
  createdBy: text('created_by').references(() => user.id),
  createdAt: createdAt(),
});

export const pairings = pgTable(
  'pairings',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    giverId: uuid('giver_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    source: pairingSource('source').notNull(),
    importId: uuid('import_id').references(() => pairingImports.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  // one gift per giver
  (t) => [
    unique('pairings_event_giver_uq').on(t.eventId, t.giverId),
    index('pairings_recipient_idx').on(t.recipientId),
  ],
);

/** No recipient column on purpose: recipient is always derived from `pairings`. */
export const gifts = pgTable(
  'gifts',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    giverId: uuid('giver_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    aliasNo: integer('alias_no').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    photoKey: text('photo_key'),
    status: giftStatus('status').notNull().default('registered'),
    openingOrder: integer('opening_order'),
    openedAt: ts('opened_at'),
    giverRevealedAt: ts('giver_revealed_at'),
    /** Organizer moderation flag. */
    hidden: boolean('hidden').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique('gifts_event_giver_uq').on(t.eventId, t.giverId),
    unique('gifts_event_alias_uq').on(t.eventId, t.aliasNo),
    // revealed <=> giver_revealed_at set; a trigger (migration 0004) makes the reveal irreversible
    check(
      'gifts_revealed_consistent',
      sql`(${t.status} = 'revealed') = (${t.giverRevealedAt} is not null)`,
    ),
  ],
);

export const votingCategories = pgTable(
  'voting_categories',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: jsonb('name').$type<Record<string, string>>().notNull(),
    description: jsonb('description').$type<Record<string, string>>(),
    enabled: boolean('enabled').notNull().default(true),
    sort: integer('sort').notNull().default(0),
    boardEnabled: boolean('board_enabled').notNull().default(false),
  },
  (t) => [unique('voting_categories_event_key_uq').on(t.eventId, t.key)],
);

/** PK(categoryId, voterId): upsert = one active selection per voter per category. */
export const votes = pgTable(
  'votes',
  {
    categoryId: uuid('category_id')
      .notNull()
      .references(() => votingCategories.id, { onDelete: 'cascade' }),
    voterId: uuid('voter_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    giftId: uuid('gift_id')
      .notNull()
      .references(() => gifts.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.categoryId, t.voterId] }), index('votes_gift_idx').on(t.giftId)],
);

export const boardPublications = pgTable(
  'board_publications',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    boardKey: text('board_key').notNull(),
    state: boardState('state').notNull().default('hidden'),
    lastPublished: jsonb('last_published'),
    lastPublishedAt: ts('last_published_at'),
    cursor: integer('cursor').notNull().default(0),
  },
  (t) => [unique('board_publications_event_board_uq').on(t.eventId, t.boardKey)],
);

export const xpLedger = pgTable(
  'xp_ledger',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    activity: text('activity').notNull(),
    amount: integer('amount').notNull(),
    rewardKey: text('reward_key').notNull(),
    qualifying: boolean('qualifying').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [unique('xp_ledger_reward_uq').on(t.eventId, t.participantId, t.rewardKey)],
);

export const participantAchievements = pgTable(
  'participant_achievements',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    unlockedAt: ts('unlocked_at').notNull().defaultNow(),
    announcedAt: ts('announced_at'),
    source: text('source').notNull(),
  },
  (t) => [unique('participant_achievements_uq').on(t.participantId, t.key)],
);

export const awards = pgTable(
  'awards',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    boardKey: text('board_key').notNull(),
    votingRound: integer('voting_round').notNull().default(1),
    winners: jsonb('winners').$type<string[]>().notNull(),
    tieInfo: jsonb('tie_info'),
    publishable: boolean('publishable').notNull().default(false),
    lockedAt: ts('locked_at'),
    invalidatedAt: ts('invalidated_at'),
    confirmedBy: text('confirmed_by').references(() => user.id),
    revealedAt: ts('revealed_at'),
  },
  (t) => [index('awards_event_idx').on(t.eventId, t.boardKey, t.votingRound)],
);

export const ceremonyState = pgTable('ceremony_state', {
  eventId: uuid('event_id')
    .primaryKey()
    .references(() => events.id, { onDelete: 'cascade' }),
  script: jsonb('script').$type<unknown[]>().notNull().default([]),
  stepIndex: integer('step_index').notNull().default(0),
});

export const scheduledJobs = pgTable(
  'scheduled_jobs',
  {
    id: id(),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    runAt: ts('run_at').notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: jobStatus('status').notNull().default('pending'),
    lockedBy: text('locked_by'),
    lockedAt: ts('locked_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [index('scheduled_jobs_due_idx').on(t.status, t.runAt)],
);

/** ADR-0004: time-boxed audited unmask grants (not in original plan data model). */
export const unmaskGrants = pgTable(
  'unmask_grants',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    reason: text('reason').notNull(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('unmask_grants_event_idx').on(t.eventId, t.expiresAt)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    target: text('target'),
    reason: text('reason'),
    data: jsonb('data'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('audit_log_event_idx').on(t.eventId, t.at)],
);

export const media = pgTable('media', {
  id: id(),
  eventId: uuid('event_id').references(() => events.id, { onDelete: 'cascade' }),
  key: text('key').notNull().unique(),
  ownerId: uuid('owner_id'),
  kind: text('kind').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  deletedAt: ts('deleted_at'),
  createdAt: createdAt(),
});
