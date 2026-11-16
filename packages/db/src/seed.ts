import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { defaultEventSettings } from '@santa/contracts';
import * as s from './schema.js';

type Db = PgDatabase<PgQueryResultHKT, typeof s>;

const NAMES = ['Giulia', 'Marco', 'Sofia', 'Luca', 'Chiara', 'Paolo', 'Elena', 'Davide'];

/** Demo event (EN/IT categories) in `gift_registration`-ready state; safe to run on an empty DB only. */
export async function seedDemoEvent(db: Db) {
  const [owner] = await db
    .insert(s.user)
    .values({
      id: 'demo-owner',
      name: 'Demo Organizer',
      email: 'organizer@example.test',
      emailVerified: true,
    })
    .returning();

  const [event] = await db
    .insert(s.events)
    .values({
      ownerId: owner!.id,
      name: 'Secret Santa 2026 / Babbo Natale Segreto 2026',
      startsAt: new Date('2026-12-18T19:00:00Z'),
      timezone: 'Europe/Rome',
      description: 'Demo event',
      budgetText: '€20',
      phase: 'gift_registration',
      settings: defaultEventSettings(),
      defaultLocale: 'it',
    })
    .returning();
  const eventId = event!.id;

  await db.insert(s.eventOrganizers).values({ eventId, userId: owner!.id, role: 'owner' });

  const people = await db
    .insert(s.participants)
    .values(
      NAMES.map((displayName) => ({
        eventId,
        displayName,
        status: 'active' as const,
        source: 'import' as const,
        locale: 'it',
      })),
    )
    .returning();

  // Ring pairing: each giver gives to the next person.
  await db.insert(s.pairings).values(
    people.map((p, i) => ({
      eventId,
      giverId: p.id,
      recipientId: people[(i + 1) % people.length]!.id,
      source: 'import' as const,
    })),
  );

  await db.insert(s.votingCategories).values([
    { eventId, key: 'best_gift', name: { en: 'Best Gift', it: 'Miglior Regalo' }, sort: 1 },
    { eventId, key: 'most_creative', name: { en: 'Most Creative', it: 'Più Creativo' }, sort: 2 },
    { eventId, key: 'funniest', name: { en: 'Funniest', it: 'Più Divertente' }, sort: 3 },
  ]);

  await db
    .insert(s.xpLedger)
    .values(
      people.map((p) => ({
        eventId,
        participantId: p.id,
        activity: 'joined',
        amount: 10,
        rewardKey: 'joined',
      })),
    );

  return { eventId, participantIds: people.map((p) => p.id) };
}
