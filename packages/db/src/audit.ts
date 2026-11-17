import { and, desc, eq, lt } from 'drizzle-orm';
import type { Db } from './types.js';
import * as s from './schema.js';

/** Keys whose values must never be written to the audit log (votes, pairings, missions). */
const SENSITIVE =
  /^(votes?|pairings?|missions?|missionKey|guess(es)?|suspectId|clues?|note|answers?|giverId|recipientId|ballots?|token|secret|password)$/i;

export function redactAuditData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditData);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SENSITIVE.test(k) ? '[redacted]' : redactAuditData(v),
      ]),
    );
  }
  return value;
}

export interface AuditInput {
  eventId?: string | null;
  actor: string;
  action: string;
  target?: string | null;
  reason?: string | null;
  data?: unknown;
  at?: Date;
}

export async function writeAudit(db: Db, a: AuditInput): Promise<void> {
  await db.insert(s.auditLog).values({
    eventId: a.eventId ?? null,
    actor: a.actor,
    action: a.action,
    target: a.target ?? null,
    reason: a.reason ?? null,
    data: a.data === undefined ? null : redactAuditData(a.data),
    ...(a.at ? { at: a.at } : {}),
  });
}

export async function listAudit(
  db: Db,
  eventId: string,
  o: { limit?: number; before?: Date } = {},
) {
  return db
    .select({
      id: s.auditLog.id,
      actor: s.auditLog.actor,
      action: s.auditLog.action,
      target: s.auditLog.target,
      reason: s.auditLog.reason,
      at: s.auditLog.at,
    })
    .from(s.auditLog)
    .where(and(eq(s.auditLog.eventId, eventId), o.before ? lt(s.auditLog.at, o.before) : undefined))
    .orderBy(desc(s.auditLog.at))
    .limit(Math.min(o.limit ?? 50, 200));
}
