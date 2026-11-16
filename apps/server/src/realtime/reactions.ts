import { and, eq } from 'drizzle-orm';
import { events, participants, type Db } from '@santa/db';
import { isActivityAllowed } from '@santa/domain';
import type { ReactionKind } from '@santa/contracts';

export type ReactionPolicy = (eventId: string, participantId: string) => Promise<boolean>;

class Bucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly perSec: number,
    private readonly now: () => number,
  ) {
    this.tokens = perSec;
    this.last = now();
  }
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.perSec, this.tokens + ((t - this.last) / 1000) * this.perSec);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export interface ReactionServiceOptions {
  perParticipantPerSec: number;
  windowMs: number;
  policy: ReactionPolicy;
  emit: (eventId: string, burst: { kind: ReactionKind; count: number }) => void;
  /** How long a policy answer is cached (organizer actions invalidate it immediately). */
  policyTtlMs?: number;
  now?: () => number;
}

/**
 * Reactions (FR-037): per-PARTICIPANT token bucket (across tabs/sockets), policy gate (event switch,
 * organizer mute, phase), aggregation into bursts per kind per window. Output carries only
 * {kind, count}: no person, no gift, so no popularity proxy.
 */
export class ReactionService {
  private readonly buckets = new Map<string, Bucket>();
  private readonly pending = new Map<string, Map<ReactionKind, number>>();
  private readonly policyCache = new Map<string, { ok: boolean; at: number }>();
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;

  constructor(private readonly o: ReactionServiceOptions) {
    this.now = o.now ?? Date.now;
  }

  async submit(eventId: string, participantId: string, kind: ReactionKind): Promise<void> {
    let bucket = this.buckets.get(participantId);
    if (!bucket) {
      bucket = new Bucket(this.o.perParticipantPerSec, this.now);
      this.buckets.set(participantId, bucket);
    }
    if (!bucket.take()) return; // spam: silently dropped
    if (!(await this.allowed(eventId, participantId))) return; // disabled/muted: silently dropped
    const perKind = this.pending.get(eventId) ?? new Map<ReactionKind, number>();
    perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
    this.pending.set(eventId, perKind);
    this.timer ??= setTimeout(() => this.flush(), this.o.windowMs);
  }

  private async allowed(eventId: string, participantId: string): Promise<boolean> {
    const key = `${eventId}|${participantId}`;
    const hit = this.policyCache.get(key);
    if (hit && this.now() - hit.at < (this.o.policyTtlMs ?? 3000)) return hit.ok;
    const ok = await this.o.policy(eventId, participantId);
    this.policyCache.set(key, { ok, at: this.now() });
    return ok;
  }

  /** Call after an organizer toggles the event switch or mutes someone. */
  invalidatePolicy(eventId?: string) {
    if (!eventId) return void this.policyCache.clear();
    for (const k of this.policyCache.keys())
      if (k.startsWith(`${eventId}|`)) this.policyCache.delete(k);
  }

  flush() {
    this.timer = undefined;
    for (const [eventId, perKind] of this.pending) {
      for (const [kind, count] of perKind)
        this.o.emit(eventId, { kind, count: Math.min(count, 500) });
    }
    this.pending.clear();
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }
}

/** DB-backed policy: event switch (settings.features.reactionsEnabled), organizer mute, phase/pause matrix. */
export function dbReactionPolicy(db: Db): ReactionPolicy {
  return async (eventId, participantId) => {
    const [row] = await db
      .select({ e: events, muted: participants.reactionsMuted, status: participants.status })
      .from(participants)
      .innerJoin(events, eq(events.id, participants.eventId))
      .where(and(eq(participants.id, participantId), eq(events.id, eventId)));
    if (!row || row.muted || row.status !== 'active') return false;
    if (!row.e.settings.features.reactionsEnabled) return false;
    return isActivityAllowed(
      {
        phase: row.e.phase,
        paused: row.e.paused,
        milestones: {
          giftOpeningStartedAt: row.e.giftOpeningStartedAt,
          votingClosedAt: row.e.votingClosedAt,
          revealStartedAt: row.e.revealStartedAt,
          ceremonyStartedAt: row.e.ceremonyStartedAt,
        },
      },
      'react',
    );
  };
}
