import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';
import { LocalizedTextSchema } from './phase2-scenes.js';

/* ---------- FR-028..030 Secret missions ---------- */

export const MISSION_STATUSES = [
  'assigned',
  'submitted',
  'verified',
  'rejected',
  'cancelled',
] as const;
export const MissionStatusSchema = z.enum(MISSION_STATUSES);

export const MISSION_NOTE_MAX = 200;

/** One of the caller's OWN missions. Missions are private: no route or stream ever shows them to anyone else. */
export const MyMissionSchema = z.strictObject({
  assignmentId: IdSchema,
  title: LocalizedTextSchema,
  description: LocalizedTextSchema,
  status: MissionStatusSchema,
  /** Completion counts (XP granted): honor system, or verified by the organizer. */
  completed: z.boolean(),
  swapsLeft: z.number().int().min(0),
});
export const MyMissionsResponseSchema = z.strictObject({
  enabled: z.boolean(),
  optedOut: z.boolean(),
  /** `organizer` = completions wait for organizer verification. */
  verification: z.enum(['none', 'organizer']),
  missions: z.array(MyMissionSchema),
});

export const MissionOptOutRequestSchema = z.strictObject({ optOut: z.boolean() });
export const MissionOptOutResponseSchema = z.strictObject({ optedOut: z.boolean() });

export const SubmitMissionRequestSchema = z
  .strictObject({ note: z.string().trim().max(MISSION_NOTE_MAX).optional() })
  .default({});
export const SubmitMissionResponseSchema = z.strictObject({
  assignmentId: IdSchema,
  status: MissionStatusSchema,
  completed: z.boolean(),
  xpAwarded: z.boolean(),
});

/** POST /api/me/missions/:assignmentId/reassign: swap for a different mission (limited by settings). */
export const ReassignMissionResponseSchema = MyMissionSchema;

/** POST /api/events/:eventId/missions/assign: tops every active, not-opted-out participant up to N missions. */
export const AssignMissionsRequestSchema = z
  .strictObject({ perParticipant: z.number().int().min(1).max(3).optional() })
  .default({});
export const AssignMissionsResponseSchema = z.strictObject({
  assigned: z.number().int().min(0),
  participants: z.number().int().min(0),
});

/**
 * GET /api/events/:eventId/missions (organizer, masked): aggregate counts + the submissions waiting for
 * verification (participant name + mission, only when the event uses organizer verification).
 * Unsubmitted assignments and opt-outs are never listed.
 */
export const OrganizerMissionsResponseSchema = z.strictObject({
  enabled: z.boolean(),
  verification: z.enum(['none', 'organizer']),
  counts: z.strictObject({
    assigned: z.number().int().min(0),
    submitted: z.number().int().min(0),
    verified: z.number().int().min(0),
  }),
  pending: z.array(
    z.strictObject({
      assignmentId: IdSchema,
      displayName: z.string(),
      title: LocalizedTextSchema,
      note: z.string().nullable(),
      submittedAt: IsoDateSchema,
    }),
  ),
});
export const VerifyMissionRequestSchema = z.strictObject({
  action: z.enum(['verify', 'reject', 'reassign']),
});
export const VerifyMissionResponseSchema = z.strictObject({
  assignmentId: IdSchema,
  status: MissionStatusSchema,
});
