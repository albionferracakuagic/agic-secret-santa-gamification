import { sql } from 'drizzle-orm';
import {
  bigserial,
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
    /** Set when the phase machine reaches `completed` (drives retention). */
    completedAt: ts('completed_at'),
    /** Platform-admin takedown: all participant/display access stops while set. */
    suspendedAt: ts('suspended_at'),
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
    /** Set by delete-my-data: personal fields erased, entry kept only as "Former player". */
    anonymizedAt: ts('anonymized_at'),
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
    /** Organizer-defined category (key c_...); editable only before voting opens. */
    custom: boolean('custom').notNull().default(false),
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
    /** Organizer enabled the live board despite a small cohort (< liveBoardMinVoters). */
    forced: boolean('forced').notNull().default(false),
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
  (t) => [
    index('awards_event_idx').on(t.eventId, t.boardKey, t.votingRound),
    // one award per category per voting round (a reopened round bumps votingRound)
    unique('awards_event_board_round_uq').on(t.eventId, t.boardKey, t.votingRound),
  ],
);

export const ceremonyState = pgTable('ceremony_state', {
  eventId: uuid('event_id')
    .primaryKey()
    .references(() => events.id, { onDelete: 'cascade' }),
  script: jsonb('script').$type<unknown[]>().notNull().default([]),
  stepIndex: integer('step_index').notNull().default(0),
  status: text('status')
    .$type<'idle' | 'running' | 'paused' | 'done' | 'cancelled'>()
    .notNull()
    .default('idle'),
  /** Server deadline of an auto-advancing step (countdown). */
  stepEndsAt: ts('step_ends_at'),
  votingRound: integer('voting_round').notNull().default(1),
  startedAt: ts('started_at'),
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

/** Persistent Idempotency-Key store (survives restarts/replicas). Rows expire; the retention job purges them. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').primaryKey(),
    fingerprint: text('fingerprint').notNull(),
    state: text('state').$type<'inflight' | 'done'>().notNull(),
    status: integer('status'),
    body: text('body'),
    contentType: text('content_type'),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('idempotency_keys_expires_idx').on(t.expiresAt)],
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

/* ---------- Phase 2 (FR-025..032) ---------- */

/** One editable guess per gift per guesser. Only the owner can ever read it; `correct` is set when the giver is revealed. */
export const santaGuesses = pgTable(
  'santa_guesses',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    giftId: uuid('gift_id')
      .notNull()
      .references(() => gifts.id, { onDelete: 'cascade' }),
    guesserId: uuid('guesser_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    suspectId: uuid('suspect_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    /** `guess` = typed in the guess screen, `prediction` = Mystery Santa Predictions mini-game. */
    source: text('source').$type<'guess' | 'prediction'>().notNull().default('guess'),
    correct: boolean('correct'),
    settledAt: ts('settled_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('santa_guesses_gift_guesser_uq').on(t.giftId, t.guesserId),
    index('santa_guesses_event_idx').on(t.eventId),
  ],
);

/** Anonymous giver clues. `giverId` is stored for authorship checks only and is never projected. */
export const santaClues = pgTable(
  'santa_clues',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    giftId: uuid('gift_id')
      .notNull()
      .references(() => gifts.id, { onDelete: 'cascade' }),
    giverId: uuid('giver_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    status: text('status')
      .$type<'pending' | 'approved' | 'rejected'>()
      .notNull()
      .default('pending'),
    decidedAt: ts('decided_at'),
    decidedBy: text('decided_by'),
    createdAt: createdAt(),
  },
  (t) => [
    index('santa_clues_event_idx').on(t.eventId, t.status),
    index('santa_clues_gift_idx').on(t.giftId),
  ],
);

export const missionAssignments = pgTable(
  'mission_assignments',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    missionKey: text('mission_key').notNull(),
    status: text('status')
      .$type<'assigned' | 'submitted' | 'verified' | 'rejected' | 'cancelled'>()
      .notNull()
      .default('assigned'),
    note: text('note'),
    swapsUsed: integer('swaps_used').notNull().default(0),
    submittedAt: ts('submitted_at'),
    verifiedAt: ts('verified_at'),
    verifiedBy: text('verified_by'),
    /** The generic "a secret mission was completed" announcement was (or will be) emitted. */
    announcedAt: ts('announced_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('mission_assignments_participant_mission_uq').on(t.participantId, t.missionKey),
    index('mission_assignments_event_idx').on(t.eventId, t.status),
  ],
);

export const missionOptOuts = pgTable(
  'mission_opt_outs',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.participantId] })],
);

export const miniGames = pgTable(
  'mini_games',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('draft'),
    title: jsonb('title').$type<Record<string, string>>().notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    /** -1 until the first round opens. */
    roundIndex: integer('round_index').notNull().default(-1),
    /** Server deadline of the current auto-advancing step. */
    stepEndsAt: ts('step_ends_at'),
    /** Bumped on every transition: a stale timer delivery is a no-op. */
    stepVersion: integer('step_version').notNull().default(0),
    /** Stored canPublish() result, set once when the game reaches `results`. */
    results: jsonb('results'),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('mini_games_event_idx').on(t.eventId),
    // at most one game on screen per event
    uniqueIndex('mini_games_one_active_uq')
      .on(t.eventId)
      .where(sql`${t.status} in ('intro','round_open','round_closed','results')`),
  ],
);

export const gameRounds = pgTable(
  'game_rounds',
  {
    id: id(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => miniGames.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    /** Full server-side round (incl. the answer); projected before it leaves the server. */
    spec: jsonb('spec').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<'pending' | 'open' | 'closed'>().notNull().default('pending'),
    opensAt: ts('opens_at'),
    endsAt: ts('ends_at'),
    closedAt: ts('closed_at'),
  },
  (t) => [unique('game_rounds_game_idx_uq').on(t.gameId, t.idx)],
);

export const gameSubmissions = pgTable(
  'game_submissions',
  {
    id: id(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => miniGames.id, { onDelete: 'cascade' }),
    roundId: uuid('round_id')
      .notNull()
      .references(() => gameRounds.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    answer: text('answer').notNull(),
    submittedAt: ts('submitted_at').notNull(),
    points: integer('points'),
  },
  (t) => [
    unique('game_submissions_round_participant_uq').on(t.roundId, t.participantId),
    index('game_submissions_game_idx').on(t.gameId),
  ],
);

export const gameScores = pgTable(
  'game_scores',
  {
    gameId: uuid('game_id')
      .notNull()
      .references(() => miniGames.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    score: integer('score').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.participantId] })],
);

export const gameBingoCards = pgTable(
  'game_bingo_cards',
  {
    gameId: uuid('game_id')
      .notNull()
      .references(() => miniGames.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    /** 25 entries, bank indexes; the free centre is null. */
    cells: jsonb('cells').$type<Array<number | null>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.participantId] })],
);

export const gameBingoMarks = pgTable(
  'game_bingo_marks',
  {
    id: id(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => miniGames.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    cell: integer('cell').notNull(),
    status: text('status')
      .$type<'pending' | 'confirmed' | 'rejected'>()
      .notNull()
      .default('pending'),
    createdAt: createdAt(),
    decidedAt: ts('decided_at'),
  },
  (t) => [unique('game_bingo_marks_uq').on(t.gameId, t.participantId, t.cell)],
);

/** The presentation currently on the display (Santa Detective etc.); the payload is already canPublish-gated. */
export const eventSpotlights = pgTable('event_spotlights', {
  eventId: uuid('event_id')
    .primaryKey()
    .references(() => events.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  shownAt: ts('shown_at').notNull(),
});

/* ---------- Phase 3 (FR-033/034/042..044) + scale-out prep ---------- */

/**
 * Append-only Santa Coin ledger. Earnings are positive; bid holds negative; releases positive again. The balance is
 * the sum. `reward_key` is server-derived and unique per participant, so no award can happen twice.
 */
export const coinLedger = pgTable(
  'coin_ledger',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    amount: integer('amount').notNull(),
    rewardKey: text('reward_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('coin_ledger_reward_uq').on(t.eventId, t.participantId, t.rewardKey),
    index('coin_ledger_participant_idx').on(t.participantId),
  ],
);

export const auctionPrizes = pgTable(
  'auction_prizes',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    title: jsonb('title').$type<Record<string, string>>().notNull(),
    /** Secret content: organizer-only until the reveal step. */
    reveal: jsonb('reveal').$type<Record<string, string>>().notNull(),
    minBid: integer('min_bid').notNull().default(1),
    status: text('status')
      .$type<'draft' | 'open' | 'closed' | 'revealed' | 'cancelled'>()
      .notNull()
      .default('draft'),
    onStage: boolean('on_stage').notNull().default(false),
    endsAt: ts('ends_at'),
    extensions: integer('extensions').notNull().default(0),
    /** Bumped when the deadline moves: a stale close timer is a no-op. */
    closeVersion: integer('close_version').notNull().default(0),
    winnerId: uuid('winner_id').references(() => participants.id, { onDelete: 'set null' }),
    winningBid: integer('winning_bid'),
    sort: integer('sort').notNull().default(0),
    createdAt: createdAt(),
    closedAt: ts('closed_at'),
    revealedAt: ts('revealed_at'),
  },
  (t) => [
    index('auction_prizes_event_idx').on(t.eventId),
    // one prize on stage per event
    uniqueIndex('auction_prizes_one_stage_uq')
      .on(t.eventId)
      .where(sql`${t.onStage}`),
  ],
);

export const auctionBids = pgTable(
  'auction_bids',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    prizeId: uuid('prize_id')
      .notNull()
      .references(() => auctionPrizes.id, { onDelete: 'cascade' }),
    bidderId: uuid('bidder_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    amount: integer('amount').notNull(),
    status: text('status').$type<'leading' | 'outbid' | 'won'>().notNull().default('leading'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('auction_bids_prize_amount_uq').on(t.prizeId, t.amount),
    index('auction_bids_prize_idx').on(t.prizeId),
  ],
);

/** Public-results snapshot of a completed event (kept per retention settings, deleted at `expires_at`). */
export const eventArchives = pgTable('event_archives', {
  eventId: uuid('event_id')
    .primaryKey()
    .references(() => events.id, { onDelete: 'cascade' }),
  snapshot: jsonb('snapshot').notNull(),
  completedAt: ts('completed_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
  builtAt: createdAt(),
});

/** One-time email link that attaches a verified participant to an account (hash only). */
export const accountLinkTokens = pgTable(
  'account_link_tokens',
  {
    id: id(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('account_link_tokens_participant_idx').on(t.participantId)],
);

/** Lifetime titles of a linked account; copied from the participant's own achievements, outlives event data. */
export const lifetimeTitles = pgTable(
  'lifetime_titles',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').notNull(),
    eventName: text('event_name').notNull(),
    year: integer('year').notNull(),
    key: text('key').notNull(),
    trophy: boolean('trophy').notNull().default(false),
    earnedAt: ts('earned_at').notNull().defaultNow(),
  },
  (t) => [unique('lifetime_titles_uq').on(t.userId, t.eventId, t.key), index('lifetime_titles_user_idx').on(t.userId)],
);

/** Qualifying XP per linked account and event, for the seasonal top-N (never shown as numbers). */
export const seasonXp = pgTable(
  'season_xp',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').notNull(),
    ownerId: text('owner_id').notNull(),
    year: integer('year').notNull(),
    xp: integer('xp').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.eventId] }), index('season_xp_owner_idx').on(t.ownerId, t.year)],
);

export const customAchievements = pgTable(
  'custom_achievements',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: jsonb('name').$type<Record<string, string>>().notNull(),
    description: jsonb('description').$type<Record<string, string>>().notNull(),
    categoryKey: text('category_key'),
    createdAt: createdAt(),
  },
  (t) => [unique('custom_achievements_event_key_uq').on(t.eventId, t.key)],
);

/**
 * Transactional outbox: written in the same transaction as the state change, relayed to the realtime bus by a
 * dispatcher (multi-instance fan-out without losing an event on crash).
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: id(),
    /** Strict relay order (timestamps can tie). */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    eventId: uuid('event_id'),
    topic: text('topic').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: createdAt(),
    dispatchedAt: ts('dispatched_at'),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [index('outbox_pending_idx').on(t.dispatchedAt, t.createdAt)],
);