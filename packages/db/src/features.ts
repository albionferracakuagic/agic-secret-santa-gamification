import {
  EventSettingsSchema,
  eventFeatures,
  phase2Settings,
  phase3Settings,
  type EventSettings,
  type FeaturesPatch,
} from '@santa/contracts';
import type { Db } from './types.js';
import * as s from './schema.js';
import { eq } from 'drizzle-orm';
import { EventError } from './events.js';
import { writeAudit } from './audit.js';
import { cancelOpenAuctions } from './auction.js';
import { loadEventRow } from './phase2.js';

type Patch = FeaturesPatch;
const SWITCHES = ['guessSanta', 'missions', 'miniGames', 'coins', 'auction', 'history'] as const;

export const featuresView = (settings: EventSettings) => ({
  features: eventFeatures(settings),
  phase2: phase2Settings(settings),
  phase3: phase3Settings(settings),
});

/**
 * Organizer feature switches and Phase 2/3 rules. Cannot touch the privacy floors (the patch schema has no such
 * keys and the merged settings are re-validated by EventSettingsSchema, whose floors are minimums).
 * Locked once the event is completed; in `awards` nothing new can be switched ON (except the history archive).
 */
export async function updateFeatures(
  db: Db,
  p: { eventId: string; actor: string; patch: Patch; now: Date },
) {
  return db.transaction(async (tx) => {
    const e = await loadEventRow(tx, p.eventId, true);
    if (e.phase === 'completed') throw new EventError('features_locked');
    const turnsOn = SWITCHES.filter((k) => p.patch[k] === true && k !== 'history');
    if (e.phase === 'awards' && turnsOn.length > 0) throw new EventError('features_locked');
    const cur = e.settings;
    const next = {
      ...cur,
      features: {
        ...cur.features,
        ...Object.fromEntries(SWITCHES.flatMap((k) => (p.patch[k] === undefined ? [] : [[k, p.patch[k]]]))),
      },
      phase2: { ...phase2Settings(cur), ...p.patch.phase2 },
      phase3: {
        coinRules: { ...phase3Settings(cur).coinRules, ...p.patch.phase3?.coinRules },
        auction: { ...phase3Settings(cur).auction, ...p.patch.phase3?.auction },
      },
    };
    const parsed = EventSettingsSchema.safeParse(next);
    if (!parsed.success)
      throw new EventError('invalid_settings', parsed.error.issues.map((i) => i.path.join('.')).join(', '));
    const f = eventFeatures(parsed.data);
    if (f.auction && !f.coins) throw new EventError('coins_disabled', 'the auction needs Santa Coins');
    await tx
      .update(s.events)
      .set({ settings: parsed.data, updatedAt: p.now })
      .where(eq(s.events.id, e.id));
    if (eventFeatures(cur).auction && !f.auction) await cancelOpenAuctions(tx, e.id, p.now);
    await writeAudit(tx, {
      eventId: e.id,
      actor: p.actor,
      action: 'features.update',
      data: { patch: p.patch },
      at: p.now,
    });
    return featuresView(parsed.data);
  });
}
