import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { eventAccess, eventOrganizers, participants, unmaskGrants, type Db } from '@santa/db';
import { hashToken, parseCookies } from './tokens.js';

export const GUEST_COOKIE = 'sg_p';
export const DISPLAY_COOKIE = 'sg_d';

export type Principal =
  | { kind: 'guest'; eventId: string; participantId: string; sessionId: string }
  | { kind: 'display'; eventId: string; sessionId: string }
  | { kind: 'organizer'; userId: string; sessionId: string };

/** Organizer sessions come from Better Auth (auth module); injected to keep this layer testable. */
export interface OrganizerSessions {
  fromCookieHeader(
    header: string | undefined,
  ): Promise<{ userId: string; sessionId: string } | null>;
  isCurrent(sessionId: string): Promise<boolean>;
}

export interface PrincipalStore {
  resolve(cookieHeader: string | undefined): Promise<Principal | null>;
  isCurrent(p: Principal): Promise<boolean>;
  isOrganizerOf(userId: string, eventId: string): Promise<boolean>;
  /** Unmask grant is active for this organizer+event right now. */
  grantActive(userId: string, eventId: string, grantId: string, now: Date): Promise<boolean>;
}

export class DbPrincipalStore implements PrincipalStore {
  constructor(
    private readonly db: Db,
    private readonly organizers: OrganizerSessions,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async resolve(cookieHeader: string | undefined): Promise<Principal | null> {
    const cookies = parseCookies(cookieHeader);
    const guest = cookies[GUEST_COOKIE];
    if (guest) {
      const sessionId = hashToken(guest);
      const [p] = await this.db
        .select({ id: participants.id, eventId: participants.eventId })
        .from(participants)
        .where(
          and(eq(participants.sessionTokenHash, sessionId), eq(participants.status, 'active')),
        );
      if (p) return { kind: 'guest', eventId: p.eventId, participantId: p.id, sessionId };
    }
    const display = cookies[DISPLAY_COOKIE];
    if (display) {
      const sessionId = hashToken(display);
      const [a] = await this.db
        .select({ eventId: eventAccess.eventId })
        .from(eventAccess)
        .where(
          and(
            eq(eventAccess.tokenHash, sessionId),
            eq(eventAccess.kind, 'display'),
            isNull(eventAccess.revokedAt),
            or(isNull(eventAccess.expiresAt), gt(eventAccess.expiresAt, this.clock())),
          ),
        );
      if (a) return { kind: 'display', eventId: a.eventId, sessionId };
    }
    const org = await this.organizers.fromCookieHeader(cookieHeader);
    return org ? { kind: 'organizer', userId: org.userId, sessionId: org.sessionId } : null;
  }

  async isCurrent(p: Principal): Promise<boolean> {
    if (p.kind === 'organizer') return this.organizers.isCurrent(p.sessionId);
    if (p.kind === 'guest') {
      const [row] = await this.db
        .select({ id: participants.id })
        .from(participants)
        .where(
          and(
            eq(participants.id, p.participantId),
            eq(participants.sessionTokenHash, p.sessionId),
            eq(participants.status, 'active'),
          ),
        );
      return !!row;
    }
    const [row] = await this.db
      .select({ id: eventAccess.id })
      .from(eventAccess)
      .where(and(eq(eventAccess.tokenHash, p.sessionId), isNull(eventAccess.revokedAt)));
    return !!row;
  }

  async isOrganizerOf(userId: string, eventId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ userId: eventOrganizers.userId })
      .from(eventOrganizers)
      .where(and(eq(eventOrganizers.userId, userId), eq(eventOrganizers.eventId, eventId)));
    return !!row;
  }

  async grantActive(userId: string, eventId: string, grantId: string, now: Date): Promise<boolean> {
    const [row] = await this.db
      .select({ id: unmaskGrants.id })
      .from(unmaskGrants)
      .where(
        and(
          eq(unmaskGrants.id, grantId),
          eq(unmaskGrants.eventId, eventId),
          eq(unmaskGrants.userId, userId),
          isNull(unmaskGrants.revokedAt),
          gt(unmaskGrants.expiresAt, now),
        ),
      );
    return !!row;
  }
}
